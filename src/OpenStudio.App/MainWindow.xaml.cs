using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace OpenStudio.App;

public partial class MainWindow : Window
{
    private const int HotkeyId = 0xB00F;
    private const int PauseHotkeyId = 0xB010;
    private const uint ModControl = 0x2, ModShift = 0x4;
    private const uint VkR = 0x52, VkP = 0x50;
    private const int WmHotkey = 0x0312;

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);

    private RecordingController? _recording;
    private Bridge? _bridge;
    private CoreWebView2Environment? _env;

    /// <summary>Project folder served at https://media.openstudio/* by our
    /// WebResourceRequested handler (Range + CORS headers included).</summary>
    public string? CurrentProjectDir { get; set; }

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += (_, __) =>
        {
            var h = new WindowInteropHelper(this).Handle;
            if (h != IntPtr.Zero)
            {
                UnregisterHotKey(h, HotkeyId);
                UnregisterHotKey(h, PauseHotkeyId);
            }
        };
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenStudio", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
        _env = env;
        await Web.EnsureCoreWebView2Async(env);
        var cw = Web.CoreWebView2;

        // Project media (screen.mp4, wavs, events.jsonl, music) is served by our own
        // handler on an UNMAPPED host: SetVirtualHostNameToFolderMapping short-circuits
        // WebResourceRequested for mapped hosts, so the media host must not be mapped.
        // Responses carry Access-Control-Allow-Origin and Range support.
        cw.AddWebResourceRequestedFilter("https://media.openstudio/*", CoreWebView2WebResourceContext.All);
        cw.WebResourceRequested += OnProjectResourceRequested;

        _recording = new RecordingController(this, PostToEditor);
        _bridge = new Bridge(this, cw, env, _recording);
        cw.AddHostObjectToScript("bridge", _bridge);

        cw.Settings.AreDefaultContextMenusEnabled = false;
        cw.Settings.IsStatusBarEnabled = false;

        // The launcher's live webcam preview uses getUserMedia; grant it silently —
        // this is our own UI, not arbitrary web content.
        cw.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind is CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Microphone)
                e.State = CoreWebView2PermissionState.Allow;
        };

        // Dev loop: set OPENSTUDIO_DEV_URL=http://localhost:5173 to use the Vite dev server.
        var devUrl = Environment.GetEnvironmentVariable("OPENSTUDIO_DEV_URL");
        if (!string.IsNullOrEmpty(devUrl))
        {
            cw.Navigate(devUrl);
        }
        else
        {
            var dist = FindEditorDist();
            if (dist == null)
            {
                cw.NavigateToString(
                    "<html><body style=\"background:#0b0d12;color:#e5e7eb;font-family:Segoe UI;display:grid;place-items:center;height:100vh\">" +
                    "<div><h2>Editor UI not found</h2><p>Build it first: <code>cd editor &amp;&amp; npm install &amp;&amp; npm run build</code></p></div></body></html>");
                return;
            }
            cw.SetVirtualHostNameToFolderMapping(
                "app.openstudio", dist, CoreWebView2HostResourceAccessKind.Allow);
            cw.Navigate("https://app.openstudio/index.html");
        }

        RegisterGlobalHotkey();
    }

    /// <summary>Locates editor/dist next to the exe (installed layout) or up the repo tree (dev layout).</summary>
    private static string? FindEditorDist()
    {
        var installed = Path.Combine(AppContext.BaseDirectory, "editor");
        if (File.Exists(Path.Combine(installed, "index.html"))) return installed;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "editor", "dist");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    private void OnProjectResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var dir = CurrentProjectDir;
            if (dir == null || _env == null)
            {
                e.Response = _env?.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            var rel = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath).TrimStart('/');
            var path = Path.GetFullPath(Path.Combine(dir, rel));
            if (!path.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            {
                e.Response = _env.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }

            var length = new FileInfo(path).Length;
            var contentType = Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".mp4" => "video/mp4",
                ".wav" => "audio/wav",
                ".mp3" => "audio/mpeg",
                ".m4a" or ".aac" => "audio/mp4",
                ".flac" => "audio/flac",
                ".json" => "application/json",
                ".jsonl" => "text/plain",
                _ => "application/octet-stream",
            };

            // Range support: the <video> element seeks with byte ranges.
            long start = 0, end = length - 1;
            var isRange = false;
            var rangeHeader = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : null;
            if (!string.IsNullOrEmpty(rangeHeader) && rangeHeader.StartsWith("bytes="))
            {
                var parts = rangeHeader["bytes=".Length..].Split('-', 2);
                if (long.TryParse(parts[0], out var s)) start = s;
                if (parts.Length > 1 && long.TryParse(parts[1], out var en)) end = en;
                start = Math.Clamp(start, 0, Math.Max(0, length - 1));
                end = Math.Clamp(end, start, length - 1);
                // Serving a shorter range than asked is valid HTTP; Chromium follows up.
                // Keeps open-ended "bytes=N-" video requests from buffering whole files.
                end = Math.Min(end, start + (8 << 20) - 1);
                isRange = true;
            }
            Log.Info($"serve {rel} ({rangeHeader ?? "full"}) → {start}-{end}/{length}");

            var common =
                $"Content-Type: {contentType}\n" +
                "Accept-Ranges: bytes\n" +
                "Access-Control-Allow-Origin: *\n" + // vite dev server runs cross-origin
                $"Content-Length: {end - start + 1}\n";
            if (isRange)
            {
                // The .NET→COM stream bridge needs a seekable stream; hand it the exact
                // range as a MemoryStream.
                var chunk = new byte[end - start + 1];
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    fs.Seek(start, SeekOrigin.Begin);
                    var read = 0;
                    while (read < chunk.Length)
                    {
                        var n = fs.Read(chunk, read, chunk.Length - read);
                        if (n <= 0) break;
                        read += n;
                    }
                }
                e.Response = _env.CreateWebResourceResponse(
                    new MemoryStream(chunk), 206, "Partial Content",
                    common + $"Content-Range: bytes {start}-{end}/{length}\n");
            }
            else
            {
                var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                e.Response = _env.CreateWebResourceResponse(stream, 200, "OK", common);
            }
        }
        catch (Exception ex)
        {
            Log.Error($"Serving {e.Request.Uri}", ex);
            e.Response = _env?.CreateWebResourceResponse(null, 500, "Error", "");
        }
    }

    public void PostToEditor(string json)
    {
        Dispatcher.Invoke(() =>
        {
            if (Web.CoreWebView2 != null) Web.CoreWebView2.PostWebMessageAsJson(json);
        });
    }

    private void RegisterGlobalHotkey()
    {
        var handle = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(handle)?.AddHook(WndProc);
        RegisterHotKey(handle, HotkeyId, ModControl | ModShift, VkR);       // Ctrl+Shift+R (§3.2)
        RegisterHotKey(handle, PauseHotkeyId, ModControl | ModShift, VkP); // Ctrl+Shift+P pause/resume
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmHotkey && wParam.ToInt32() == HotkeyId)
        {
            handled = true;
            _ = _recording?.ToggleAsync();
        }
        else if (msg == WmHotkey && wParam.ToInt32() == PauseHotkeyId)
        {
            handled = true;
            _recording?.TogglePause();
        }
        return IntPtr.Zero;
    }
}
