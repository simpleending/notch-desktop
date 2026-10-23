$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class NotchConsoleObserver141 {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct Entry { public uint size,usage,pid; public IntPtr heap; public uint module,threads,parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap,ref Entry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap,ref Entry entry);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr data);
 delegate bool EnumProc(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,System.Text.StringBuilder text,int max);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 static HashSet<IntPtr> windows;
 static void Consoles(){EnumWindows((window,data)=>{if(IsWindowVisible(window)&&!windows.Contains(window)){var text=new System.Text.StringBuilder(256);GetClassName(window,text,256);if((text.ToString()=="ConsoleWindowClass"||text.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"||text.ToString()=="VirtualConsoleClass")){uint pid;GetWindowThreadProcessId(window,out pid);windows.Add(window);rows.Add(new Row{Pid=pid,Name="VISIBLE_CONSOLE:"+text.ToString(),Milliseconds=(long)(DateTime.UtcNow-start).TotalMilliseconds});}}return true;},IntPtr.Zero);}
 public class Row { public uint Pid,Parent;public string Name;public long Milliseconds; }
 static Thread worker;static volatile bool running;static HashSet<uint> seen;static List<Row> rows;static DateTime start;
 static void Read(bool record){var snap=CreateToolhelp32Snapshot(2,0);if(snap==new IntPtr(-1))return;try{var entry=new Entry();entry.size=(uint)Marshal.SizeOf<Entry>();if(Process32FirstW(snap,ref entry))do{if(seen.Add(entry.pid)&&record)rows.Add(new Row{Pid=entry.pid,Parent=entry.parent,Name=entry.exe,Milliseconds=(long)(DateTime.UtcNow-start).TotalMilliseconds});}while(Process32NextW(snap,ref entry));}finally{CloseHandle(snap);}}
 public static void Start(){windows=new HashSet<IntPtr>();seen=new HashSet<uint>();rows=new List<Row>();start=DateTime.UtcNow;Read(false);Consoles();rows.Clear();running=true;worker=new Thread(()=>{while(running){Read(true);Consoles();Thread.Sleep(4);}});worker.Start();}
 public static Row[] Stop(){running=false;worker.Join();return rows.ToArray();}
}
'@

[NotchConsoleObserver141]::Start()
Set-Content -LiteralPath $args[0] -Value 'ready'
try {
 $observerDeadline=[DateTime]::UtcNow.AddMinutes(8)
 while (!(Test-Path -LiteralPath $args[2]) -and [DateTime]::UtcNow -lt $observerDeadline) { Start-Sleep -Milliseconds 100 }
} finally {
$observedRows=[NotchConsoleObserver141]::Stop()
[pscustomobject]@{VisibleConsoles=@($observedRows | Where-Object Name -like 'VISIBLE_CONSOLE:*');Processes=$observedRows} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $args[1]
}
