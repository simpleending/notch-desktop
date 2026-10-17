$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { @{name=$_.VoiceInfo.Name; language=$_.VoiceInfo.Culture.Name} })
  [Console]::Write((ConvertTo-Json -InputObject $voices -Compress))
} finally { $speaker.Dispose() }
