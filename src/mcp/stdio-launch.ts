import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SDK 2.4.0 disposes a probe by immediately killing its launcher. Windows cannot
// deliver SIGTERM to a Node handler, so cleanup must survive a launcher hard kill.
// The launcher itself enters a kill-on-close Job before it creates any server.
// Its non-inheritable Job handle then owns every descendant, including .cmd files.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
const windowsHost = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
# Avoid module discovery stalling before Add-Type in a minimal stdio environment.
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ResidualXMcpHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedData, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static int Run(string node, string host) {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        // Do not inherit or close this handle explicitly: process termination
        // closes it, killing both this owner and any surviving descendants.
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        var startup = new StartupInfo();
        startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
        startup.Flags = 0x100; // STARTF_USESTDHANDLES
        startup.Stdin = GetStdHandle(-10); startup.Stdout = GetStdHandle(-11); startup.Stderr = GetStdHandle(-12);
        Check(SetHandleInformation(startup.Stdin, 1, 1));
        Check(SetHandleInformation(startup.Stdout, 1, 1));
        Check(SetHandleInformation(startup.Stderr, 1, 1));
        // Only trusted executable/file paths appear here; server arguments are
        // JSON in the environment and are never interpolated into shell code.
        var command = new StringBuilder("\"" + node + "\" \"" + host + "\" --env-payload");
        ProcessInfo child;
        Check(CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000,
            IntPtr.Zero, null, ref startup, out child));
        CloseHandle(child.Thread);
        try {
            Check(WaitForSingleObject(child.Process, 0xffffffff) == 0);
            uint code; Check(GetExitCodeProcess(child.Process, out code));
            return unchecked((int)code);
        } finally { CloseHandle(child.Process); }
    }
}
'@
exit ([ResidualXMcpHost]::Run($env:_RESIDUALX_MCP_NODE, $env:_RESIDUALX_MCP_HOST))
} catch {
    [Console]::Error.WriteLine('MCP process owner could not start.')
    exit 1
}
`;

export function stdioLaunch(command: string, args: string[], env: Record<string, string>) {
	const host = fileURLToPath(new URL("./stdio-host.mjs", import.meta.url));
	if (process.platform !== "win32") return { command: process.execPath, args: [host, command, ...args], env };
	return {
		command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsHost, "utf16le").toString("base64")],
		env: { ...env, _RESIDUALX_MCP_NODE: process.execPath, _RESIDUALX_MCP_HOST: host, _RESIDUALX_MCP_ARGV: JSON.stringify([command, ...args]) },
	};
}
