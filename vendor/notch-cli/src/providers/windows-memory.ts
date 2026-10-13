import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);

// WMI AdapterRAM is a 32-bit value; DXGI reports reserved GPU memory correctly above 4 GiB.
const query = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NotchGpuMemory {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapter(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDescription(IntPtr self, out Description description);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Description {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Name;
    public uint Vendor, Device, Subsystem, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  static Delegate Method(IntPtr instance, int slot, Type type) {
    IntPtr table=Marshal.ReadIntPtr(instance);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot*IntPtr.Size), type);
  }
  public static ulong LargestDedicatedMemory() {
    Guid iid=new Guid("770AAE78-F26F-4DBA-A829-253C83D1B387"); IntPtr factory;
    if(CreateDXGIFactory1(ref iid,out factory)<0)return 0;
    ulong largest=0;
    try {
      EnumAdapter enumerate=(EnumAdapter)Method(factory,12,typeof(EnumAdapter));
      for(uint index=0;index<32;index++) {
        IntPtr adapter;if(enumerate(factory,index,out adapter)<0)break;
        try {
          Description desc;
          GetDescription describe=(GetDescription)Method(adapter,10,typeof(GetDescription));
          if(describe(adapter,out desc)>=0 && (desc.Flags&2)==0)largest=Math.Max(largest,desc.DedicatedVideoMemory.ToUInt64());
        } finally {Marshal.Release(adapter);}
      }
    } finally {Marshal.Release(factory);}
    return largest;
  }
}
'@
$used = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue | Measure-Object -Property DedicatedUsage -Maximum).Maximum
$installed = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum
@{installedMemory=$installed;dedicatedMemory=[NotchGpuMemory]::LargestDedicatedMemory();dedicatedUsage=$used} | ConvertTo-Json -Compress
`;

let cache: { at: number; value: { installedMemory: number; availableVram: number } } | undefined;
export async function windowsMemory(): Promise<{ installedMemory: number; availableVram: number }> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const executable = path.join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true });
  const data = JSON.parse(stdout.trim()) as { installedMemory?: number; dedicatedMemory?: number; dedicatedUsage?: number };
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!valid(data.installedMemory) || !valid(data.dedicatedMemory) || !valid(data.dedicatedUsage)) throw new Error('Windows GPU memory telemetry is unavailable.');
  const value = { installedMemory: data.installedMemory, availableVram: Math.max(0, data.dedicatedMemory - data.dedicatedUsage) };
  cache = { at: Date.now(), value }; return value;
}
