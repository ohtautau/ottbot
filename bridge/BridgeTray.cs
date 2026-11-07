using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Ottbot
{
    public sealed class TrayApplication : ApplicationContext
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        readonly string root, state, shell, id;
        readonly NotifyIcon tray = new NotifyIcon();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly Icon online, waiting, stopped;
        readonly EventWaitHandle stopEvent;
        readonly EventWaitHandle showEvent;
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("正在启动…");
        readonly ToolStripMenuItem reconnectItem = new ToolStripMenuItem("重新连接");
        readonly ToolStripMenuItem pauseItem = new ToolStripMenuItem("暂停电脑执行");
        readonly ToolStripMenuItem startupItem = new ToolStripMenuItem("登录后自动启动");
        Task<Snapshot> probe;
        Task operation;
        DateTime nextProbe = DateTime.MinValue, nextStart = DateTime.MinValue;
        bool paused, quitting, shutdownStopping;
        Snapshot latest = new Snapshot();
        Form statusForm;
        TextBox details;

        sealed class Snapshot
        {
            public bool Supervisor, Worker, Connected, Busy;
            public string Model = "尚未读取";
        }

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            string directory = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            Run(directory, Array.IndexOf(args, "--background") >= 0);
        }

        public static void Run(string directory, bool background)
        {
            directory = Path.GetFullPath(directory).TrimEnd('\\');
            string identity = Identity(directory);
            bool created;
            using (var mutex = new Mutex(true, @"Local\Ottbot.Tray." + identity, out created))
            {
                if (!created)
                {
                    if (!background) try { using (var show = EventWaitHandle.OpenExisting(@"Local\Ottbot.Tray.Show." + identity)) show.Set(); } catch { }
                    return;
                }
                try { using (var app = new TrayApplication(directory, identity, background)) Application.Run(app); }
                finally { mutex.ReleaseMutex(); }
            }
        }

        static string Identity(string directory)
        {
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(directory.ToLowerInvariant()))).Replace("-", "").Substring(0, 16);
        }

        TrayApplication(string directory, string identity, bool background)
        {
            root = directory; id = identity;
            state = Path.Combine(root, @"local-state\codex-bridge");
            shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\WindowsPowerShell\v1.0\powershell.exe");
            Directory.CreateDirectory(state);
            stopEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Ottbot.Tray.Stop." + id);
            showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\Ottbot.Tray.Show." + id);
            online = MakeIcon(Color.FromArgb(34, 197, 94));
            waiting = MakeIcon(Color.FromArgb(245, 158, 11));
            stopped = MakeIcon(Color.FromArgb(239, 68, 68));
            statusItem.Enabled = false;
            var menu = new ContextMenuStrip();
            menu.Items.Add(statusItem);
            menu.Items.Add("查看状态", null, delegate { ShowStatus(); });
            menu.Items.Add(new ToolStripSeparator());
            reconnectItem.Click += delegate { Reconnect(); };
            pauseItem.Click += delegate { paused = true; BeginStop(false); };
            startupItem.Click += delegate { ChangeStartup(); };
            menu.Items.Add(reconnectItem); menu.Items.Add(pauseItem);
            menu.Items.Add("打开日志文件夹", null, delegate { Process.Start("explorer.exe", Quote(state)); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(startupItem);
            menu.Items.Add("退出", null, delegate { Quit(); });
            menu.Opening += delegate { startupItem.Checked = StartupEnabled(); };
            tray.ContextMenuStrip = menu;
            tray.Icon = waiting; tray.Text = "Ottbot · 正在连接"; tray.Visible = true;
            tray.DoubleClick += delegate { ShowStatus(); };
            File.WriteAllText(Path.Combine(state, "tray.pid"), Process.GetCurrentProcess().Id.ToString());
            timer.Interval = 1000;
            timer.Tick += delegate { Tick(); };
            timer.Start(); Tick();
            if (!background) ShowStatus();
        }

        Dictionary<string, object> Config()
        {
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(state, "worker.json"), Encoding.UTF8));
        }

        bool SupervisorRunning()
        {
            try
            {
                int pid = int.Parse(File.ReadAllText(Path.Combine(state, "supervisor.pid")).Trim());
                using (var search = new ManagementObjectSearcher("SELECT Name, CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                using (var rows = search.Get())
                    foreach (ManagementObject row in rows)
                        using (row)
                        {
                            string name = Convert.ToString(row["Name"]), command = Convert.ToString(row["CommandLine"]).Replace('/', '\\');
                            return (name.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("pwsh.exe", StringComparison.OrdinalIgnoreCase))
                                && command.IndexOf(Path.Combine(root, @"bridge\start-bridge.ps1"), StringComparison.OrdinalIgnoreCase) >= 0;
                        }
            }
            catch { }
            return false;
        }

        async Task<Dictionary<string, object>> Health(int port, string token)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:" + port + "/health"))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                using (var response = await http.SendAsync(request).ConfigureAwait(false))
                {
                    response.EnsureSuccessStatusCode();
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
                }
            }
        }

        async Task<Snapshot> Probe()
        {
            var result = new Snapshot { Supervisor = SupervisorRunning() };
            try
            {
                var config = Config();
                try
                {
                    var worker = await Health(Convert.ToInt32(config["port"]), Convert.ToString(config["workerToken"])).ConfigureAwait(false);
                    result.Worker = Flag(worker, "ok"); result.Busy = Flag(worker, "busy");
                }
                catch { }
                try
                {
                    var relay = await Health(Convert.ToInt32(config["localRelayPort"]), Convert.ToString(config["clientToken"])).ConfigureAwait(false);
                    result.Connected = result.Worker && Flag(relay, "ok") && Flag(relay, "computerOnline");
                    if (relay.ContainsKey("model")) result.Model = Convert.ToString(relay["model"]);
                }
                catch { }
            }
            catch { }
            return result;
        }

        static bool Flag(Dictionary<string, object> data, string name) { return data.ContainsKey(name) && data[name] is bool && (bool)data[name]; }
        static string Quote(string path) { return "\"" + path + "\""; }

        Process Script(string file, string extra, bool log)
        {
            var info = new ProcessStartInfo(shell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(Path.Combine(root, "bridge", file)) + extra)
            { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = log, RedirectStandardError = log };
            var process = new Process { StartInfo = info };
            if (log)
            {
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("supervisor.log", e.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("supervisor-error.log", e.Data); };
            }
            process.Start();
            if (log) { process.BeginOutputReadLine(); process.BeginErrorReadLine(); }
            return process;
        }

        void Log(string name, string line)
        {
            try { lock (http) File.AppendAllText(Path.Combine(state, name), line + Environment.NewLine, Encoding.UTF8); } catch { }
        }

        void BeginStart()
        {
            nextStart = DateTime.UtcNow.AddSeconds(30);
            operation = Task.Run(delegate
            {
                if (SupervisorRunning()) return;
                var process = Script("start-bridge.ps1", "", true);
                File.WriteAllText(Path.Combine(state, "supervisor.pid"), process.Id.ToString());
            });
        }

        void BeginStop(bool restart)
        {
            if (operation != null && !operation.IsCompleted) return;
            operation = Task.Run(delegate
            {
                using (var process = Script("stop-bridge.ps1", " -KeepTray", false))
                    if (!process.WaitForExit(20000) || process.ExitCode != 0) throw new IOException("Bridge stop did not complete");
                if (restart)
                {
                    var process = Script("start-bridge.ps1", "", true);
                    File.WriteAllText(Path.Combine(state, "supervisor.pid"), process.Id.ToString());
                }
            });
            nextStart = DateTime.UtcNow.AddSeconds(30);
            nextProbe = DateTime.MinValue;
        }

        void Reconnect() { if (latest.Busy) return; paused = false; BeginStop(true); }
        void Quit() { if (quitting) return; quitting = true; paused = true; }

        void Tick()
        {
            if (stopEvent.WaitOne(0)) Quit();
            if (showEvent.WaitOne(0)) ShowStatus();
            if (operation != null && operation.IsCompleted)
            {
                if (operation.IsFaulted) Log("tray-error.log", "代理操作未完成；请检查本机日志和登录状态。");
                operation = null;
            }
            if (quitting && operation == null)
            {
                if (!shutdownStopping) { shutdownStopping = true; BeginStop(false); return; }
                ExitThread(); return;
            }
            if (probe != null && probe.IsCompleted)
            {
                latest = probe.IsFaulted ? new Snapshot() : probe.Result;
                probe = null; UpdateDisplay();
                if (!paused && !latest.Supervisor && operation == null && DateTime.UtcNow >= nextStart) BeginStart();
            }
            if (probe == null && DateTime.UtcNow >= nextProbe)
            {
                nextProbe = DateTime.UtcNow.AddSeconds(5);
                probe = Task.Run((Func<Task<Snapshot>>)Probe);
            }
        }

        string CurrentStatus() { return paused ? "已暂停" : latest.Connected ? (latest.Busy ? "正在执行任务" : "在线") : latest.Supervisor ? "正在连接服务器" : "执行端启动中／等待重试"; }

        void UpdateDisplay()
        {
            string status = CurrentStatus();
            tray.Icon = paused ? stopped : latest.Connected ? online : waiting;
            tray.Text = "Ottbot 电脑执行端 · " + status;
            statusItem.Text = status;
            reconnectItem.Enabled = !latest.Busy && operation == null;
            pauseItem.Enabled = !paused && !latest.Busy && operation == null;
            startupItem.Checked = StartupEnabled();
            if (details != null) { string text = DetailText(); if (details.Text != text) details.Text = text; }
            try
            {
                var text = json.Serialize(new { status, connected = latest.Connected, busy = latest.Busy, paused,
                    autostart = startupItem.Checked, trayPid = Process.GetCurrentProcess().Id,
                    statusWindowVisible = statusForm != null && !statusForm.IsDisposed && statusForm.Visible, updatedAt = DateTime.UtcNow.ToString("o") });
                string path = Path.Combine(state, "tray-status.json"), temporary = path + ".tmp";
                File.WriteAllText(temporary, text, new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            }
            catch { }
        }

        bool StartupEnabled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                string value = key == null ? "" : Convert.ToString(key.GetValue("Ottbot"));
                return value.IndexOf(Path.Combine(root, @"bridge\tray-bridge.ps1"), StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }

        void ChangeStartup()
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    string previous = Convert.ToString(key.GetValue("Ottbot"));
                    string script = Path.Combine(root, @"bridge\tray-bridge.ps1");
                    if (previous.Length > 0 && previous.IndexOf(script, StringComparison.OrdinalIgnoreCase) < 0)
                        throw new IOException("Different startup entry");
                    if (StartupEnabled()) key.DeleteValue("Ottbot", false);
                    else key.SetValue("Ottbot", Quote(shell) + " -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File " + Quote(script), RegistryValueKind.String);
                }
                startupItem.Checked = StartupEnabled();
            }
            catch { MessageBox.Show("无法更新登录启动项，请检查本机权限。", "Ottbot", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        string DetailText()
        {
            var text = new StringBuilder();
            text.AppendLine("状态：" + CurrentStatus());
            text.AppendLine("本机执行端：" + (latest.Worker ? "在线" : "未连接"));
            text.AppendLine("服务器回连：" + (latest.Connected ? "在线" : "未连接"));
            text.AppendLine("当前模型：" + latest.Model);
            text.AppendLine("登录后自动启动：" + (StartupEnabled() ? "已开启" : "未开启"));
            try
            {
                var config = Config(); text.AppendLine(); text.AppendLine("工作目录：" + config["workspace"]);
                text.AppendLine("联网权限：" + (Flag(config, "networkAccess") ? "允许" : "默认限制"));
                text.AppendLine("命令审批：" + (Flag(config, "autoReview") ? "自动审查" : "默认"));
                if (config.ContainsKey("writableDirectories"))
                    foreach (var directory in (IEnumerable)config["writableDirectories"]) text.AppendLine("额外可写：" + directory);
            }
            catch { text.AppendLine("配置暂时无法读取。"); }
            text.AppendLine(); text.AppendLine("绿：在线　黄：连接中　红：暂停");
            return text.ToString();
        }

        void ShowStatus()
        {
            if (statusForm != null && !statusForm.IsDisposed) { statusForm.Show(); statusForm.WindowState = FormWindowState.Normal; statusForm.Activate(); return; }
            statusForm = new Form { Text = "Ottbot 电脑执行端", Size = new Size(620, 440), StartPosition = FormStartPosition.CenterScreen,
                FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, Icon = tray.Icon, Font = new Font("Microsoft YaHei UI", 10) };
            details = new TextBox { Dock = DockStyle.Fill, ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None,
                WordWrap = true, ScrollBars = ScrollBars.Vertical, Text = DetailText(), BackColor = SystemColors.Window };
            var body = new Panel { Dock = DockStyle.Fill, Padding = new Padding(18) };
            body.Controls.Add(details);
            var controls = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 48, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
            var close = new Button { Text = "关闭", Width = 90, Height = 30 };
            close.Click += delegate { statusForm.Close(); };
            var reconnect = new Button { Text = "重新连接", Width = 100, Height = 30 };
            reconnect.Click += delegate { Reconnect(); };
            controls.Controls.Add(close); controls.Controls.Add(reconnect);
            statusForm.Controls.Add(body); statusForm.Controls.Add(controls);
            statusForm.FormClosed += delegate { details = null; };
            statusForm.Show();
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
        Icon MakeIcon(Color color)
        {
            using (var image = new Bitmap(32, 32))
            using (var graphics = Graphics.FromImage(image))
            using (var logo = Image.FromFile(Path.Combine(root, @"bridge\assets\ottbot-logo.png")))
            using (var brush = new SolidBrush(color))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                graphics.DrawImage(logo, new Rectangle(0, 0, 32, 32));
                graphics.FillEllipse(Brushes.White, 21, 21, 11, 11); graphics.FillEllipse(brush, 23, 23, 7, 7);
                var handle = image.GetHicon();
                try { using (var icon = Icon.FromHandle(handle)) return (Icon)icon.Clone(); }
                finally { DestroyIcon(handle); }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Stop(); timer.Dispose(); tray.Visible = false; tray.Dispose(); online.Dispose(); waiting.Dispose(); stopped.Dispose();
                stopEvent.Dispose(); showEvent.Dispose(); http.Dispose(); if (statusForm != null) statusForm.Dispose();
                try { File.Delete(Path.Combine(state, "tray.pid")); } catch { }
            }
            base.Dispose(disposing);
        }
    }
}
