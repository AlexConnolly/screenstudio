using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using OpenStudio.Recorder.Capture;

namespace OpenStudio.App;

/// <summary>Floating recording indicator (§3.2) — excluded from capture, draggable,
/// shows elapsed time with Stop / Discard actions.</summary>
public partial class PillWindow : Window
{
    private readonly DispatcherTimer _timer;
    private readonly Func<TimeSpan> _elapsed;

    public event Action? StopRequested;
    public event Action? CancelRequested;
    public event Action? PauseToggled;

    public PillWindow(MonitorDescriptor monitor, Func<TimeSpan> elapsed)
    {
        InitializeComponent();
        _elapsed = elapsed;
        SourceInitialized += (_, __) =>
        {
            CaptureExclusion.ExcludeFromCapture(this);
            // Bottom-center of the recorded monitor; size in pixels is approximate
            // (the window auto-sizes) — only the anchor point matters.
            var hwndW = (int)(220 * monitor.Scale);
            var hwndH = (int)(52 * monitor.Scale);
            CaptureExclusion.MovePixels(
                this,
                monitor.X + monitor.Width / 2 - hwndW / 2,
                monitor.Y + monitor.Height - hwndH - (int)(24 * monitor.Scale),
                hwndW, hwndH);
        };
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _timer.Tick += (_, __) =>
        {
            var t = _elapsed();
            TimeText.Text = t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");
            RecDot.Opacity = t.Milliseconds < 500 ? 1.0 : 0.35; // gentle blink
        };
        _timer.Start();
    }

    private void OnDrag(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    private void OnStop(object sender, RoutedEventArgs e) => StopRequested?.Invoke();

    private void OnPause(object sender, RoutedEventArgs e) => PauseToggled?.Invoke();

    public void SetPaused(bool paused)
    {
        PauseButton.Content = paused ? "▶" : "❚❚";
        RecDot.Fill = paused
            ? new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF5, 0x9E, 0x0B))
            : new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xEF, 0x44, 0x44));
    }

    private void OnCancel(object sender, RoutedEventArgs e) => CancelRequested?.Invoke();

    protected override void OnClosed(EventArgs e)
    {
        _timer.Stop();
        base.OnClosed(e);
    }
}
