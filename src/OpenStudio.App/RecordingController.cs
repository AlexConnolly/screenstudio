using System.IO;
using System.Windows;
using OpenStudio.Core;
using OpenStudio.Recorder;
using OpenStudio.Recorder.Capture;

namespace OpenStudio.App;

/// <summary>
/// Recording state machine: idle → countdown → recording → processing → idle.
/// Drives the countdown overlay and pill (both capture-excluded), and notifies the
/// editor UI over the WebView2 message channel.
/// </summary>
public sealed class RecordingController
{
    private readonly Window _mainWindow;
    private readonly Action<string> _postToEditor;
    private RecordingSession? _session;
    private PillWindow? _pill;
    private CancellationTokenSource? _countdownCts;
    private RecordingOptions _lastOptions = new();
    private int _countdownSeconds = 3;
    private string _state = "idle";

    public RecordingController(Window mainWindow, Action<string> postToEditor)
    {
        _mainWindow = mainWindow;
        _postToEditor = postToEditor;
    }

    public bool IsBusy => _state != "idle";

    public string StorageDir { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "OpenStudio");

    private void SetState(string state)
    {
        _state = state;
        _postToEditor($"{{\"type\":\"recording:state\",\"state\":\"{state}\"}}");
    }

    public Task ToggleAsync() => _state switch
    {
        "idle" => StartAsync(_lastOptions, _countdownSeconds),
        "recording" or "paused" => StopAsync(),
        "countdown" => CancelAsync(),
        _ => Task.CompletedTask,
    };

    /// <summary>Pause/resume (§3.2) — pauses become hard cuts in one continuous timeline.</summary>
    public void TogglePause()
    {
        if (_session == null) return;
        if (_session.IsPaused)
        {
            _session.Resume();
            SetState("recording");
        }
        else
        {
            _session.Pause();
            SetState("paused");
        }
        _pill?.SetPaused(_session.IsPaused);
    }

    public async Task StartAsync(RecordingOptions options, int countdownSeconds)
    {
        if (IsBusy) return;
        _lastOptions = options;
        _countdownSeconds = countdownSeconds;
        var monitor = Monitors.ByDeviceName(options.MonitorDeviceName);
        if (monitor == null) return;

        _mainWindow.Hide();
        SetState("countdown");
        if (countdownSeconds > 0)
        {
            _countdownCts = new CancellationTokenSource();
            var countdown = new CountdownWindow(monitor);
            try
            {
                await countdown.RunAsync(countdownSeconds, _countdownCts.Token);
            }
            catch (OperationCanceledException)
            {
                SetState("idle");
                _mainWindow.Show();
                return;
            }
            finally
            {
                _countdownCts = null;
            }
        }

        try
        {
            var name = $"Recording {DateTime.Now:yyyy-MM-dd HH-mm-ss}.osproj";
            Directory.CreateDirectory(StorageDir);
            var projectDir = Path.Combine(StorageDir, name);
            // Off the UI thread: session start does D3D/WGC/MediaCapture work, and
            // blocking the STA thread on WinRT async deadlocks the whole app.
            _session = await Task.Run(() => RecordingSession.Start(projectDir, options));
            Log.Info($"Recording started → {projectDir} (source={options.SourceType})");
        }
        catch (Exception ex)
        {
            Log.Error("Failed to start recording", ex);
            SetState("idle");
            _mainWindow.Show();
            _postToEditor(Json.Serialize(new { type = "recording:error", message = ex.Message }));
            return;
        }

        SetState("recording");
        _pill = new PillWindow(monitor, () => _session?.Elapsed ?? TimeSpan.Zero);
        _pill.StopRequested += () => _ = StopAsync();
        _pill.CancelRequested += () => _ = CancelAsync();
        _pill.PauseToggled += TogglePause;
        _pill.Show();
    }

    public async Task StopAsync()
    {
        if (_state == "countdown")
        {
            _countdownCts?.Cancel();
            return;
        }
        if (_session == null) return;
        var session = _session;
        _session = null;

        ClosePill();
        SetState("processing");
        _mainWindow.Show();
        _mainWindow.Activate();
        try
        {
            var path = await Task.Run(session.FinishAsync);
            RecentProjects.Add(path);
            SetState("idle");
            Log.Info($"Recording finished → {path}");
            _postToEditor(Json.Serialize(new { type = "recording:finished", path }));
        }
        catch (Exception ex)
        {
            Log.Error("Failed to finish recording", ex);
            SetState("idle");
            _postToEditor(Json.Serialize(new { type = "recording:error", message = ex.Message }));
        }
    }

    public async Task CancelAsync()
    {
        if (_state == "countdown")
        {
            _countdownCts?.Cancel();
            return;
        }
        if (_session == null) return;
        var session = _session;
        _session = null;
        ClosePill();
        SetState("processing");
        await Task.Run(session.CancelAsync);
        SetState("idle");
        _mainWindow.Show();
    }

    private void ClosePill()
    {
        _pill?.Close();
        _pill = null;
    }
}
