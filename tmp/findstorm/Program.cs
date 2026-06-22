using System;
using System.IO;
using System.Reflection;
using System.Linq;

class Program {
    static void Main() {
        var roots = new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vintagestory"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vintagestory", "Mods"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vintagestory", "Lib"),
        };
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
            var name = new AssemblyName(e.Name).Name + ".dll";
            foreach (var r in roots) {
                var p = Path.Combine(r, name);
                if (File.Exists(p)) return Assembly.LoadFrom(p);
            }
            return null;
        };
        foreach (var root in roots.Take(2)) {
            foreach (var dll in Directory.GetFiles(root, "*.dll")) {
                Type[] types;
                try {
                    var asm = Assembly.LoadFrom(dll);
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
                } catch (Exception e) { Console.WriteLine($"ERR {Path.GetFileName(dll)}: {e.Message}"); continue; }
                foreach (var t in types) {
                    if (t.Name.IndexOf("Temporal", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        t.Name.IndexOf("Storm", StringComparison.OrdinalIgnoreCase) >= 0) {
                        Console.WriteLine($"{Path.GetFileName(dll)} :: {t.FullName}");
                    }
                }
            }
        }
    }
}
