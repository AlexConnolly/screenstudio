using System.IO;
using OpenStudio.Core;

namespace OpenStudio.App;

/// <summary>Recent-projects list shown on the launcher (§7.1). Projects themselves are
/// portable folders; this is just bookmarks in %LOCALAPPDATA%.</summary>
public static class RecentProjects
{
    private static readonly object Lock = new();

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OpenStudio", "recent.json");

    public static List<string> List()
    {
        lock (Lock)
        {
            try
            {
                if (!File.Exists(FilePath)) return new List<string>();
                return Json.Deserialize<List<string>>(File.ReadAllText(FilePath)) ?? new List<string>();
            }
            catch
            {
                return new List<string>();
            }
        }
    }

    public static void Add(string projectDir)
    {
        lock (Lock)
        {
            var list = List();
            list.Remove(projectDir);
            list.Insert(0, projectDir);
            if (list.Count > 30) list.RemoveRange(30, list.Count - 30);
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, Json.Serialize(list, indented: true));
        }
    }
}
