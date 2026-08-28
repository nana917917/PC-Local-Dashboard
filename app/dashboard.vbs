Option Explicit
Dim fso, shell, appDir, nodePath, nodeFile, stream, serverPath, commandLine
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeFile = fso.BuildPath(appDir, "node-path.txt")
nodePath = ""
If fso.FileExists(nodeFile) Then
  Set stream = fso.OpenTextFile(nodeFile, 1, False, -1)
  nodePath = stream.ReadAll
  stream.Close
  nodePath = Replace(nodePath, vbCr, "")
  nodePath = Replace(nodePath, vbLf, "")
  nodePath = Replace(nodePath, ChrW(&HFEFF), "")
End If

If Len(nodePath) = 0 Or Not fso.FileExists(nodePath) Then
  nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
End If

If Not fso.FileExists(nodePath) Then
  MsgBox "Node.js was not found. Run SETUP.cmd again.", 16, "PC Local Dashboard"
  WScript.Quit 2
End If

serverPath = fso.BuildPath(appDir, "server.js")
If Not fso.FileExists(serverPath) Then
  MsgBox "server.js was not found. Run SETUP.cmd again.", 16, "PC Local Dashboard"
  WScript.Quit 3
End If

shell.CurrentDirectory = appDir
commandLine = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & serverPath & Chr(34)
shell.Run commandLine, 0, False
