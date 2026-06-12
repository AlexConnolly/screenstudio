using OpenStudio.Core.Models;
using OpenStudio.Core.Zoom;
using Xunit;

namespace OpenStudio.Core.Tests;

public class AutoZoomGeneratorTests
{
    private const double W = 1920;
    private const double H = 1080;

    private static InputEvent Click(double tMs, double x, double y) =>
        new() { T = tMs, K = "down", B = 0, X = x, Y = y };

    private static InputEvent Key(double tMs) =>
        new() { T = tMs, K = "key", A = 1, Vk = -1 };

    private static AutoZoomTunables Tunables() => new();

    [Fact]
    public void SingleClick_CreatesOneSegmentAroundClick()
    {
        var events = new[] { Click(5000, 960, 540) };
        var segs = AutoZoomGenerator.Generate(events, W, H, 30, Tunables());

        var s = Assert.Single(segs);
        Assert.True(s.Start < 5.0 && s.Start > 4.5, $"lead-in expected, got {s.Start}");
        Assert.True(s.End > 5.0 + 2.0, $"dwell expected, got {s.End}");
        Assert.Equal(0.5, s.Cx, 2);
        Assert.Equal(0.5, s.Cy, 2);
        Assert.Equal("auto", s.Kind);
    }

    [Fact]
    public void CloseClicks_ClusterIntoOneSegment()
    {
        var events = new[]
        {
            Click(1000, 500, 500),
            Click(2000, 550, 520),
            Click(3500, 600, 480),
        };
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables());
        Assert.Single(segs);
    }

    [Fact]
    public void SpatiallyDistantClicks_StaySeparateSegments()
    {
        var events = new[]
        {
            Click(1000, 100, 100),
            Click(2000, 1800, 1000), // far corner, inside cluster window but outside radius
        };
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables());
        Assert.Equal(2, segs.Count);
        // Near-adjacent segments are made contiguous so the camera blends directly.
        Assert.Equal(segs[1].Start, segs[0].End, 3);
    }

    [Fact]
    public void TemporallyDistantClicks_StaySeparate()
    {
        var events = new[]
        {
            Click(1000, 500, 500),
            Click(20000, 520, 510),
        };
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables());
        Assert.Equal(2, segs.Count);
        Assert.True(segs[1].Start - segs[0].End > 1.0, "distant clicks should leave a full-frame gap");
    }

    [Fact]
    public void TypingBurst_CreatesSegmentAnchoredAtLastClick()
    {
        var events = new List<InputEvent> { Click(1000, 400, 300) };
        // Typing burst from t=10s, well after the click cluster has expired.
        for (var i = 0; i < 10; i++) events.Add(Key(10000 + i * 200));

        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables());
        Assert.Equal(2, segs.Count);
        var typing = segs[1];
        Assert.Equal(400.0 / W, typing.Cx, 2);
        Assert.Equal(300.0 / H, typing.Cy, 2);
        Assert.True(typing.End >= 10.0 + 9 * 0.2, "segment should hold while typing continues");
    }

    [Fact]
    public void FewKeys_DoNotTriggerTypingZoom()
    {
        var events = new[] { Key(5000), Key(5400) }; // only 2 keys
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables());
        Assert.Empty(segs);
    }

    [Fact]
    public void Intensity_RescalesZoomLevel()
    {
        var events = new[] { Click(1000, 960, 540) };
        var t = Tunables();
        t.Intensity = 0.5;
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, t);
        Assert.Equal(1.0 + 0.75 * 0.5, Assert.Single(segs).Zoom, 5);
    }

    [Fact]
    public void PinnedSegments_SurviveRegenerationAndCarveAutos()
    {
        var events = new[] { Click(5000, 960, 540) };
        var pinned = new[]
        {
            new ZoomSegment { Kind = "manual", Start = 4.0, End = 12.0, Zoom = 3.0, Cx = 0.2, Cy = 0.2 },
        };
        var segs = AutoZoomGenerator.Generate(events, W, H, 60, Tunables(), pinned);

        var manual = Assert.Single(segs); // auto fully inside pinned → dropped, manual kept
        Assert.Equal("manual", manual.Kind);
        Assert.Equal(3.0, manual.Zoom);
    }

    [Fact]
    public void SegmentsClampToRecordingDuration()
    {
        var events = new[] { Click(500, 0, 0), Click(29500, 1920, 1080) };
        var segs = AutoZoomGenerator.Generate(events, W, H, 30, Tunables());
        Assert.All(segs, s =>
        {
            Assert.True(s.Start >= 0);
            Assert.True(s.End <= 30);
            Assert.InRange(s.Cx, 0, 1);
            Assert.InRange(s.Cy, 0, 1);
        });
    }

    [Fact]
    public void EventLog_RoundTripsAndToleratesTornLine()
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(path, new[]
            {
                EventLog.WriteLine(new InputEvent { T = 1, K = "move", X = 10, Y = 20 }),
                EventLog.WriteLine(new InputEvent { T = 2, K = "down", B = 0, X = 10, Y = 20 }),
                "{\"t\":3,\"k\":\"mo", // torn write after crash
            });
            var events = EventLog.Read(path);
            Assert.Equal(2, events.Count);
            Assert.Equal("move", events[0].K);
            Assert.Equal(20, events[0].Y);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
