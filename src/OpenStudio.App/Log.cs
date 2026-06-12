using System.IO;

namespace OpenStudio.App;

/// <summary>Append-only diagnostics at %LOCALAPPDATA%\OpenStudio\logs\app.log —
/// recording/export failures in the field are invisible without this.</summary>
public static class Log
{
    private static readonly object Lock = new();

    private static string FilePath
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenStudio", "logs");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "app.log");
        }
    }

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string context, Exception ex) => Write("ERROR", $"{context}: {ex}");

    private static void Write(string level, string message)
    {
        try
        {
            lock (Lock)
            {
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}{Environment.NewLine}");
            }
        }
        catch { /* logging must never throw */ }
    }
}
