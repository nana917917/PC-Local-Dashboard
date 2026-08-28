Option Explicit
Dim fso, shell, appDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(appDir, "WattSeal.exe")
If fso.FileExists(exePath) Then
  shell.CurrentDirectory = appDir
  shell.Run Chr(34) & exePath & Chr(34) & " --background", 0, False
End If
