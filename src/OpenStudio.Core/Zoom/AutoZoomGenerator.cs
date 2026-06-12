using OpenStudio.Core.Models;

namespace OpenStudio.Core.Zoom;

/// <summary>
/// The analyze step of the pipeline (§7.2): events.jsonl → click clusters / typing runs
/// → auto zoom segments. Pure and deterministic so regeneration is instant and safe;
/// manual/pinned segments are never touched (§4.1).
/// </summary>
public static class AutoZoomGenerator
{
    private readonly record struct Interaction(double Start, double End, double X, double Y);

    public static List<ZoomSegment> Generate(
        IReadOnlyList<InputEvent> events,
        double width,
        double height,
        double durationSec,
        AutoZoomTunables t,
        IReadOnlyList<ZoomSegment>? keep = null)
    {
        var interactions = CollectInteractions(events, width, height, t);
        var clusters = Cluster(interactions, width, height, t);
        var segments = new List<ZoomSegment>();

        foreach (var cluster in clusters)
        {
            var start = Math.Max(0, cluster[0].Start - t.LeadIn);
            var end = Math.Min(durationSec, cluster[^1].End + t.Dwell);
            if (end - start < 0.5) continue;

            // Centroid weighted toward later interactions: the camera should settle where
            // the activity ended up, follow-cursor covers the journey there.
            double wx = 0, wy = 0, wsum = 0;
            for (var i = 0; i < cluster.Count; i++)
            {
                var w = 1.0 + i;
                wx += cluster[i].X * w;
                wy += cluster[i].Y * w;
                wsum += w;
            }

            segments.Add(new ZoomSegment
            {
                Kind = "auto",
                Start = start,
                End = end,
                Zoom = 1.0 + (t.DefaultZoom - 1.0) * t.Intensity,
                Cx = Math.Clamp(wx / wsum / width, 0, 1),
                Cy = Math.Clamp(wy / wsum / height, 0, 1),
                Follow = true,
                EaseIn = t.EaseIn,
                EaseOut = t.EaseOut,
            });
        }

        // Make near-adjacent segments contiguous so the camera glides target→target
        // instead of bouncing through full frame (§4.1 zoom-thrash avoidance).
        for (var i = 0; i < segments.Count - 1; i++)
        {
            if (segments[i + 1].Start - segments[i].End < t.MergeGap)
                segments[i].End = segments[i + 1].Start;
        }

        // Respect pinned/manual segments: carve autos around them.
        if (keep is { Count: > 0 })
        {
            var kept = keep.Where(s => s.Kind == "manual" || s.Pinned)
                           .OrderBy(s => s.Start).ToList();
            segments = segments
                .SelectMany(a => Subtract(a, kept))
                .Where(a => a.End - a.Start >= 1.0)
                .ToList();
            segments.AddRange(kept);
            segments.Sort((a, b) => a.Start.CompareTo(b.Start));
        }

        return segments;
    }

    private static List<Interaction> CollectInteractions(
        IReadOnlyList<InputEvent> events, double width, double height, AutoZoomTunables t)
    {
        var result = new List<Interaction>();
        double lastClickX = width / 2, lastClickY = height / 2;
        var keyDowns = new List<double>();

        foreach (var ev in events)
        {
            switch (ev.K)
            {
                case "down":
                    result.Add(new Interaction(ev.T / 1000.0, ev.T / 1000.0, ev.X, ev.Y));
                    lastClickX = ev.X;
                    lastClickY = ev.Y;
                    break;
                case "key" when ev.A == 1:
                    keyDowns.Add(ev.T / 1000.0);
                    break;
            }
        }

        // Typing runs: >= TypingMinKeys keys inside TypingWindow starts a run anchored at
        // the last click position (caret approximation, §4.1); run extends while keys keep coming.
        var maxGap = Math.Max(1.5, t.TypingWindow * 1.5);
        var i = 0;
        while (i <= keyDowns.Count - t.TypingMinKeys)
        {
            if (keyDowns[i + t.TypingMinKeys - 1] - keyDowns[i] <= t.TypingWindow)
            {
                var runStart = keyDowns[i];
                var j = i + t.TypingMinKeys - 1;
                while (j + 1 < keyDowns.Count && keyDowns[j + 1] - keyDowns[j] <= maxGap) j++;

                // Anchor at the most recent click before the run started.
                double ax = width / 2, ay = height / 2;
                foreach (var click in result)
                {
                    if (click.Start > runStart) break;
                    ax = click.X;
                    ay = click.Y;
                }
                result.Add(new Interaction(runStart, keyDowns[j], ax, ay));
                i = j + 1;
            }
            else
            {
                i++;
            }
        }

        result.Sort((a, b) => a.Start.CompareTo(b.Start));
        return result;
    }

    private static List<List<Interaction>> Cluster(
        List<Interaction> interactions, double width, double height, AutoZoomTunables t)
    {
        var clusters = new List<List<Interaction>>();
        var radius = t.ClusterRadiusFrac * Math.Max(width, height);

        foreach (var it in interactions)
        {
            var current = clusters.Count > 0 ? clusters[^1] : null;
            if (current != null)
            {
                var lastActivity = current.Max(c => c.End);
                var cx = current.Average(c => c.X);
                var cy = current.Average(c => c.Y);
                var dist = Math.Sqrt((it.X - cx) * (it.X - cx) + (it.Y - cy) * (it.Y - cy));
                if (it.Start - lastActivity <= t.ClusterWindow && dist <= radius)
                {
                    current.Add(it);
                    continue;
                }
            }
            clusters.Add(new List<Interaction> { it });
        }

        return clusters;
    }

    /// <summary>Returns the parts of <paramref name="auto"/> not covered by any kept segment.</summary>
    private static IEnumerable<ZoomSegment> Subtract(ZoomSegment auto, List<ZoomSegment> kept)
    {
        var pieces = new List<(double Start, double End)> { (auto.Start, auto.End) };
        foreach (var k in kept)
        {
            var next = new List<(double Start, double End)>();
            foreach (var p in pieces)
            {
                if (k.End <= p.Start || k.Start >= p.End)
                {
                    next.Add(p);
                    continue;
                }
                if (k.Start > p.Start) next.Add((p.Start, k.Start));
                if (k.End < p.End) next.Add((k.End, p.End));
            }
            pieces = next;
        }

        foreach (var p in pieces)
        {
            yield return new ZoomSegment
            {
                Kind = "auto",
                Start = p.Start,
                End = p.End,
                Zoom = auto.Zoom,
                Cx = auto.Cx,
                Cy = auto.Cy,
                Follow = auto.Follow,
                EaseIn = auto.EaseIn,
                EaseOut = auto.EaseOut,
            };
        }
    }
}
