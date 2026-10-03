// armadra-launch：Windows 上的画布启动器（控制台程序，docs/design/canvas-launcher.md §5）。
//
// 数据目录里每个有注入的 CLI 有两份它的副本：`integration\run\<cli>.exe`（启动器）
// 与 `integration\shims\<cli>.exe`（垫片），各自旁边一份同名的 `.launch`。敲进节点
// shell 的那一行是 `run\claude.exe <程序> [前置词…] <CLI 的旗标…>`；注入的 argv 与
// 环境写在 `.launch` 里，不经 PTY、不经 shell，没有长度与引用问题。
//
// `.launch`（UTF-8，`\r\n` 或 `\n`，`#` 开头是注释）：
//
//   armadra-launch 1             首行，认不出就退出码 1
//   gate=ARMADRA_NODE_ID         这个变量为空时不注入（画布外重跑那一行 = 普通启动）
//   program=C:\…\node.exe        只在垫片模式：要起的程序（core 解析 PATH 与 npm 包装后写入）
//   lead=C:\…\cli.js             只在垫片模式：排在程序后面的词，可多条
//   env=NAME=value               注入：只给 CLI 进程设的环境变量，可多条
//   arg=value                    注入：接在调用者参数之后的词，可多条
//
// 值是原文：不加引号、不转义，不含换行。
//
// 启动器模式（没有 program=）：调用者命令行尾巴的第一个词是程序，尾巴原样就是子进程
// 的整条命令行，注入的词按 C 运行库的规则加引号接在后面——调用者的参数一个字节都
// 不经过第二次解释。垫片模式：程序与前置词来自 `.launch`，尾巴整段是 CLI 的参数；
// 启动前从 PATH 摘掉自己的目录，CLI 再起同名程序时找到的是真程序，不会二次注入。
//
// 程序是 `.cmd` / `.bat`（读不出的包装）时经 `cmd.exe /d /s /c "…"` 起，`cmd.exe` 会把
// 整行再读一遍：只有每个注入词都不含 `" % ^ & | < > ( )` 时才注入，否则不注入并在
// stderr 说一句。
//
// 其余照抄 Hook 的启动器（cli/armadra-hook/windows-launcher.cs）：控制台子系统、
// CREATE_SUSPENDED + KILL_ON_JOB_CLOSE 的作业对象、Ctrl+C 交给子进程、透传退出码。
// 不设 ELECTRON_RUN_AS_NODE。只用 C# 5 与 .NET Framework 4 的类库，由每台 Windows
// 自带的 csc.exe 编译（apps/desktop/scripts/launch-exe.mjs），anycpu。

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class ArmadraLaunch
{
    private const string Header = "armadra-launch 1";

    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    /// <summary>`.launch` 读出来的内容。</summary>
    private sealed class LaunchConfig
    {
        public string Gate;
        public string Program;
        public readonly List<string> Lead = new List<string>();
        public readonly List<KeyValuePair<string, string>> Env = new List<KeyValuePair<string, string>>();
        public readonly List<string> Args = new List<string>();
    }

    private static int Main()
    {
        try
        {
            return Run();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("armadra-launch: " + error.Message);
            return 1;
        }
    }

    private static int Run()
    {
        string self = Assembly.GetEntryAssembly().Location;
        string selfDir = Path.GetDirectoryName(self);
        string configPath = Path.ChangeExtension(self, ".launch");
        if (!File.Exists(configPath))
        {
            Console.Error.WriteLine("armadra-launch: launcher config missing: " + configPath);
            return 1;
        }
        string problem;
        LaunchConfig config = Parse(File.ReadAllLines(configPath, new UTF8Encoding(false)), out problem);
        if (config == null)
        {
            Console.Error.WriteLine("armadra-launch: " + configPath + ": " + problem);
            return 1;
        }

        string tail = Tail(Environment.CommandLine);
        bool shim = config.Program != null;
        string program;
        string rest;
        if (shim)
        {
            program = config.Program;
            rest = tail;
        }
        else
        {
            int end;
            program = FirstArgument(tail, out end);
            if (program == null)
            {
                Console.Error.WriteLine("armadra-launch: usage: <launcher> <program> [arguments...]");
                return 2;
            }
            rest = tail.Substring(end);
        }

        // 垫片：先把自己的目录从 PATH 摘掉——找程序与子进程的 PATH 都不再有垫片。
        if (shim)
            Environment.SetEnvironmentVariable("PATH", WithoutDirectory(Environment.GetEnvironmentVariable("PATH"), selfDir));

        string resolved = Resolve(program, selfDir);
        if (resolved == null)
        {
            Console.Error.WriteLine("armadra-launch: program not found: " + program);
            return 1;
        }

        bool batch = IsBatch(resolved);
        bool inject = config.Gate == null || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(config.Gate));
        if (inject && batch && !config.Args.TrueForAll(BatchSafe))
        {
            Console.Error.WriteLine(
                "Armadra: " + resolved + " is a batch wrapper; canvas injection skipped");
            inject = false;
        }

        StringBuilder body = new StringBuilder();
        if (shim || batch)
        {
            // 程序换成解析后的绝对路径；其后是前置词与调用者的尾巴（原文）。
            body.Append(ArgQuote(resolved));
            foreach (string word in config.Lead) body.Append(' ').Append(ArgQuote(word));
            body.Append(rest);
        }
        else
        {
            // 启动器模式：尾巴原样就是整条命令行。
            body.Append(tail.TrimStart(' ', '\t'));
        }
        if (inject)
        {
            foreach (KeyValuePair<string, string> pair in config.Env)
                Environment.SetEnvironmentVariable(pair.Key, pair.Value);
            foreach (string word in config.Args) body.Append(' ').Append(ArgQuote(word));
        }

        string application = resolved;
        StringBuilder commandLine = body;
        if (batch)
        {
            application = CommandProcessor();
            commandLine = new StringBuilder();
            commandLine.Append(ArgQuote(application)).Append(" /d /s /c \"").Append(body.ToString()).Append('"');
        }
        return Start(application, commandLine);
    }

    /// <summary>读 `.launch`；认不出时答 null，并在 problem 里说为什么。</summary>
    private static LaunchConfig Parse(string[] lines, out string problem)
    {
        problem = null;
        if (lines.Length == 0 || lines[0].TrimStart('\uFEFF') != Header)
        {
            problem = "first line is not \"" + Header + "\"";
            return null;
        }
        LaunchConfig config = new LaunchConfig();
        for (int index = 1; index < lines.Length; index++)
        {
            string line = lines[index];
            if (line.Length == 0 || line[0] == '#') continue;
            int equals = line.IndexOf('=');
            if (equals <= 0)
            {
                problem = "line " + (index + 1) + " is not key=value";
                return null;
            }
            string key = line.Substring(0, equals);
            string value = line.Substring(equals + 1);
            switch (key)
            {
                case "gate":
                    config.Gate = value;
                    break;
                case "program":
                    config.Program = value;
                    break;
                case "lead":
                    config.Lead.Add(value);
                    break;
                case "arg":
                    config.Args.Add(value);
                    break;
                case "env":
                    int split = value.IndexOf('=');
                    if (split <= 0)
                    {
                        problem = "line " + (index + 1) + " is not env=NAME=value";
                        return null;
                    }
                    config.Env.Add(new KeyValuePair<string, string>(value.Substring(0, split), value.Substring(split + 1)));
                    break;
                default:
                    problem = "line " + (index + 1) + " has an unknown key: " + key;
                    return null;
            }
        }
        if (config.Program == null && config.Lead.Count > 0)
        {
            problem = "lead= without program=";
            return null;
        }
        if (config.Program != null && config.Program.Length == 0)
        {
            problem = "program= is empty";
            return null;
        }
        return config;
    }

    private static int Start(string application, StringBuilder commandLine)
    {
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = Inheritable(GetStdHandle(STD_INPUT_HANDLE));
        startup.hStdOutput = Inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
        startup.hStdError = Inheritable(GetStdHandle(STD_ERROR_HANDLE));

        // Ctrl+C / Ctrl+Break 到达整个控制台进程组：子进程自己处理，启动器等它退出。
        // 不能用 SetConsoleCtrlHandler(NULL, TRUE)，那个「忽略」标志会被子进程继承。
        try
        {
            Console.CancelKeyPress += delegate (object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        }
        catch (Exception)
        {
        }

        PROCESS_INFORMATION process;
        if (!CreateProcessW(
                application,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
        {
            int code = Marshal.GetLastWin32Error();
            Console.Error.WriteLine(
                "armadra-launch: could not start " + application + ": " + new Win32Exception(code).Message);
            return 1;
        }

        // 作业对象失败（所在作业不许嵌套）不致命：只是少了「一起退出」这一条。
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, size)
                || !AssignProcessToJobObject(job, process.hProcess))
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
        }

        ResumeThread(process.hThread);
        CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) exitCode = 1;
        CloseHandle(process.hProcess);
        return unchecked((int)exitCode);
    }

    /// <summary>
    /// 调用方命令行里 argv[0] 之后的部分，原样返回（带前导空白）。与 Hook 启动器的
    /// 同名函数相同：argv[0] 以引号开头就到下一个引号为止，否则到第一个空白为止。
    /// </summary>
    internal static string Tail(string commandLine)
    {
        int index = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            int close = commandLine.IndexOf('"', 1);
            index = close < 0 ? commandLine.Length : close + 1;
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] != ' ' && commandLine[index] != '\t')
                index++;
        }
        string rest = commandLine.Substring(index);
        if (rest.Trim().Length == 0) return "";
        return rest[0] == ' ' || rest[0] == '\t' ? rest : " " + rest;
    }

    /// <summary>
    /// 按 C 运行库的规则读出 text 的第一个参数，end 是它之后的位置；没有参数答 null。
    /// 反斜杠只在引号前有意义：2n 个加一个 `"` 是 n 个反斜杠加引号开关，2n+1 个是
    /// n 个反斜杠加一个字面的 `"`；引号里的 `""` 是一个字面的 `"`。
    /// </summary>
    internal static string FirstArgument(string text, out int end)
    {
        int index = 0;
        while (index < text.Length && (text[index] == ' ' || text[index] == '\t')) index++;
        end = index;
        if (index >= text.Length) return null;
        StringBuilder value = new StringBuilder();
        bool quoted = false;
        while (index < text.Length)
        {
            char c = text[index];
            if (!quoted && (c == ' ' || c == '\t')) break;
            if (c == '\\')
            {
                int slashes = 0;
                while (index < text.Length && text[index] == '\\') { slashes++; index++; }
                if (index < text.Length && text[index] == '"')
                {
                    value.Append('\\', slashes / 2);
                    if (slashes % 2 == 1) { value.Append('"'); index++; }
                }
                else
                {
                    value.Append('\\', slashes);
                }
                continue;
            }
            if (c == '"')
            {
                if (quoted && index + 1 < text.Length && text[index + 1] == '"')
                {
                    value.Append('"');
                    index += 2;
                    continue;
                }
                quoted = !quoted;
                index++;
                continue;
            }
            value.Append(c);
            index++;
        }
        end = index;
        return value.ToString();
    }

    /// <summary>
    /// C 运行库的引号规则（与 terminal/shell.ts 的 argvQuote 相同）：包在双引号里，
    /// `"` 写成 `\"`，紧挨着引号（含收尾那个）的反斜杠加倍。
    /// </summary>
    internal static string ArgQuote(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            if (c == '"')
            {
                quoted.Append('\\', slashes * 2 + 1).Append('"');
            }
            else
            {
                quoted.Append('\\', slashes).Append(c);
            }
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2).Append('"');
        return quoted.ToString();
    }

    /// <summary>`cmd.exe` 第二遍读时会动到的字符一个都没有（terminal/shell.ts 的 batchSafeWord）。</summary>
    internal static bool BatchSafe(string word)
    {
        return word.IndexOfAny(new[] { '"', '%', '^', '&', '|', '<', '>', '(', ')', '\r', '\n' }) < 0;
    }

    private static bool IsBatch(string program)
    {
        string extension = Path.GetExtension(program);
        return string.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase)
            || string.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase);
    }

    private static string CommandProcessor()
    {
        string comspec = Environment.GetEnvironmentVariable("ComSpec");
        if (!string.IsNullOrEmpty(comspec) && File.Exists(comspec)) return comspec;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
    }

    /// <summary>
    /// 程序的绝对路径。带目录的按原样（缺扩展名时按 PATHEXT 补）；裸名在 PATH 里找，
    /// 跳过启动器自己的目录——`run\claude.exe claude` 不能找回自己。找不到答 null。
    /// </summary>
    private static string Resolve(string program, string selfDir)
    {
        string[] extensions = Extensions();
        if (program.IndexOf('\\') >= 0 || program.IndexOf('/') >= 0 || program.IndexOf(':') >= 0)
            return Existing(program, extensions);
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string entry in path.Split(';'))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0 || SameDirectory(directory, selfDir)) continue;
            string found;
            try
            {
                found = Existing(Path.Combine(directory, program), extensions);
            }
            catch (ArgumentException)
            {
                continue;
            }
            if (found != null) return found;
        }
        return null;
    }

    private static string Existing(string candidate, string[] extensions)
    {
        if (Path.HasExtension(candidate) && File.Exists(candidate)) return Path.GetFullPath(candidate);
        foreach (string extension in extensions)
        {
            string withExtension = candidate + extension;
            if (File.Exists(withExtension)) return Path.GetFullPath(withExtension);
        }
        return null;
    }

    private static string[] Extensions()
    {
        string pathext = Environment.GetEnvironmentVariable("PATHEXT");
        if (string.IsNullOrEmpty(pathext)) pathext = ".COM;.EXE;.BAT;.CMD";
        List<string> extensions = new List<string>();
        foreach (string extension in pathext.Split(';'))
        {
            string trimmed = extension.Trim();
            if (trimmed.StartsWith(".")) extensions.Add(trimmed);
        }
        return extensions.ToArray();
    }

    /// <summary>PATH 去掉 directory 那几条（大小写不敏感，忽略尾部的 `\`）。</summary>
    internal static string WithoutDirectory(string path, string directory)
    {
        if (string.IsNullOrEmpty(path)) return path ?? "";
        List<string> kept = new List<string>();
        foreach (string entry in path.Split(';'))
        {
            if (entry.Length > 0 && SameDirectory(entry.Trim().Trim('"'), directory)) continue;
            kept.Add(entry);
        }
        return string.Join(";", kept.ToArray());
    }

    private static bool SameDirectory(string a, string b)
    {
        return string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase);
    }

    private static string Normalize(string directory)
    {
        string full = directory;
        try
        {
            full = Path.GetFullPath(directory);
        }
        catch (Exception)
        {
        }
        return full.TrimEnd('\\', '/');
    }

    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return handle;
    }
}
