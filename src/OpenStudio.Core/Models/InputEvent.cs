using System.Text.Json;

namespace OpenStudio.Core.Models;

/// <summary>
/// One line of events.jsonl. Terse field names keep the log small at 120+ Hz.
/// Kinds: "move" (x,y), "down"/"up" (b,x,y), "wheel" (d,x,y),
/// "key" (a: 1=down 0=up, vk: -1 when privacy-stripped, mods), "cursor" (c).
/// Timestamps are milliseconds from session start (QPC-derived), coordinates are
/// capture-space physical pixels.
/// </summary>
public sealed class InputEvent
{
    public double T { get; set; }
    public string K { get; set; } = "";
    public double X { get; set; }
    public double Y { get; set; }
    public int B { get; set; }
    public int D { get; set; }
    public int A { get; set; }
    public int Vk { get; set; } = -1;
    public string? Mods { get; set; }
    public string? C { get; set; }
}

public static class EventLog
{
    public static List<InputEvent> Read(string path)
    {
        var list = new List<InputEvent>();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var ev = JsonSerializer.Deserialize<InputEvent>(line, Json.Options);
                if (ev != null) list.Add(ev);
            }
            catch (JsonException)
            {
                // Tolerate a torn final line after a crash (§7.1 crash safety).
            }
        }
        return list;
    }

    public static string WriteLine(InputEvent ev) => JsonSerializer.Serialize(ev, Json.Options);
}
