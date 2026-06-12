using System.Windows;
using OpenStudio.Recorder.Capture;

namespace OpenStudio.App;

public partial class CountdownWindow : Window
{
    public CountdownWindow(MonitorDescriptor monitor)
    {
        InitializeComponent();
        SourceInitialized += (_, __) =>
        {
            CaptureExclusion.ExcludeFromCapture(this);
            CaptureExclusion.MovePixels(this, monitor.X, monitor.Y, monitor.Width, monitor.Height);
        };
    }

    public async Task RunAsync(int seconds, CancellationToken ct)
    {
        Show();
        try
        {
            for (var i = seconds; i > 0; i--)
            {
                CountText.Text = i.ToString();
                await Task.Delay(1000, ct);
            }
        }
        finally
        {
            Close();
        }
    }
}
