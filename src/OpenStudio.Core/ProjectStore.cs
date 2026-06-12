using OpenStudio.Core.Models;

namespace OpenStudio.Core;

/// <summary>Load/save of the self-contained project folder (§7.1).</summary>
public static class ProjectStore
{
    public static ProjectFile LoadProject(string projectDir) =>
        Json.Deserialize<ProjectFile>(File.ReadAllText(Path.Combine(projectDir, ProjectPaths.ProjectJson)))
            ?? throw new InvalidDataException($"Invalid project.json in {projectDir}");

    public static CaptureMeta LoadMeta(string projectDir) =>
        Json.Deserialize<CaptureMeta>(File.ReadAllText(Path.Combine(projectDir, ProjectPaths.MetaJson)))
            ?? throw new InvalidDataException($"Invalid meta.json in {projectDir}");

    public static List<InputEvent> LoadEvents(string projectDir) =>
        EventLog.Read(Path.Combine(projectDir, ProjectPaths.EventsJsonl));

    public static void SaveProject(string projectDir, ProjectFile project)
    {
        // Write-then-rename so a crash mid-save never corrupts project.json.
        var path = Path.Combine(projectDir, ProjectPaths.ProjectJson);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, Json.Serialize(project, indented: true));
        File.Move(tmp, path, overwrite: true);
    }

    public static void SaveMeta(string projectDir, CaptureMeta meta) =>
        File.WriteAllText(Path.Combine(projectDir, ProjectPaths.MetaJson), Json.Serialize(meta, indented: true));

    public static bool IsProject(string dir) =>
        File.Exists(Path.Combine(dir, ProjectPaths.MetaJson)) &&
        File.Exists(Path.Combine(dir, ProjectPaths.ScreenMp4));
}
