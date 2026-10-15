param([long]$WindowHandle, [uint32]$OwnerPid, [uint32]$Message, [uint64]$Word, [long]$Flags)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NotchSessionMessage {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr word, IntPtr flags, uint options, uint timeout, out UIntPtr result);
}
'@
# Never broadcast: only the window belonging to this test's launched main process.
if ($WindowHandle -le 65535 -or $OwnerPid -eq 0 -or $Message -notin @(17,22)) { throw 'Invalid isolated session message target' }
[uint32]$actualOwner = 0
[void][NotchSessionMessage]::GetWindowThreadProcessId([IntPtr]$WindowHandle, [ref]$actualOwner)
if ($actualOwner -ne $OwnerPid) { throw 'Window no longer belongs to the test process' }
[UIntPtr]$result = [UIntPtr]::Zero
$sent = [NotchSessionMessage]::SendMessageTimeoutW([IntPtr]$WindowHandle,$Message,[UIntPtr]$Word,[IntPtr]$Flags,2,5000,[ref]$result)
@{sent=$sent.ToInt64();result=$result.ToUInt64();error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()} | ConvertTo-Json -Compress
