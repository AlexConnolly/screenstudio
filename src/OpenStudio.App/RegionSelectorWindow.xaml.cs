using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using OpenStudio.Recorder;
using OpenStudio.Recorder.Capture;

namespace OpenStudio.App;

/// <summary>Drag-select overlay for custom-region capture (§3.1). Returns the region in
/// physical pixels relative to the monitor's origin via <see cref="Result"/>.</summary>
public partial class RegionSelectorWindow : Window
{
    private Point? _start;
    private double _scale = 1.0;

    public RegionRect? Result { get; private set; }

    public RegionSelectorWindow(MonitorDescriptor monitor)
    {
        InitializeComponent();
        SourceInitialized += (_, __) =>
        {
            CaptureExclusion.ExcludeFromCapture(this);
            CaptureExclusion.MovePixels(this, monitor.X, monitor.Y, monitor.Width, monitor.Height);
        };
        Loaded += (_, __) =>
        {
            _scale = VisualTreeHelper.GetDpi(this).DpiScaleX;
            UpdateDim(new Rect(0, 0, 0, 0));
            Activate();
            Focus();
        };
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Result = null;
            Close();
        }
    }

    private void OnDown(object sender, MouseButtonEventArgs e)
    {
        _start = e.GetPosition(Surface);
        Surface.CaptureMouse();
    }

    private void OnMove(object sender, MouseEventArgs e)
    {
        if (_start is not { } s) return;
        var rect = MakeRect(s, e.GetPosition(Surface));
        System.Windows.Controls.Canvas.SetLeft(Sel, rect.X);
        System.Windows.Controls.Canvas.SetTop(Sel, rect.Y);
        Sel.Width = rect.Width;
        Sel.Height = rect.Height;
        UpdateDim(rect);

        SizeLabel.Visibility = Visibility.Visible;
        SizeText.Text = $"{(int)(rect.Width * _scale)} × {(int)(rect.Height * _scale)}";
        System.Windows.Controls.Canvas.SetLeft(SizeLabel, rect.X + rect.Width / 2 - 40);
        System.Windows.Controls.Canvas.SetTop(SizeLabel, Math.Max(4, rect.Y - 34));
    }

    private void OnUp(object sender, MouseButtonEventArgs e)
    {
        Surface.ReleaseMouseCapture();
        if (_start is not { } s)
        {
            Close();
            return;
        }
        var rect = MakeRect(s, e.GetPosition(Surface));
        if (rect.Width * _scale >= 64 && rect.Height * _scale >= 64)
        {
            Result = new RegionRect
            {
                X = (int)(rect.X * _scale),
                Y = (int)(rect.Y * _scale),
                W = (int)(rect.Width * _scale),
                H = (int)(rect.Height * _scale),
            };
        }
        Close();
    }

    private static Rect MakeRect(Point a, Point b) => new(
        Math.Min(a.X, b.X), Math.Min(a.Y, b.Y),
        Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));

    private void UpdateDim(Rect sel)
    {
        var w = Surface.ActualWidth;
        var h = Surface.ActualHeight;
        Set(DimTop, 0, 0, w, sel.Y);
        Set(DimBottom, 0, sel.Bottom, w, Math.Max(0, h - sel.Bottom));
        Set(DimLeft, 0, sel.Y, sel.X, sel.Height);
        Set(DimRight, sel.Right, sel.Y, Math.Max(0, w - sel.Right), sel.Height);

        static void Set(System.Windows.Shapes.Rectangle r, double x, double y, double width, double height)
        {
            System.Windows.Controls.Canvas.SetLeft(r, x);
            System.Windows.Controls.Canvas.SetTop(r, y);
            r.Width = Math.Max(0, width);
            r.Height = Math.Max(0, height);
        }
    }
}
