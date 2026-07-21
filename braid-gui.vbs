' braid GUI launcher — starts braid with NO visible console window and opens
' the control panel. Double-click this file (or make a shortcut to it).
'
' Unlike braid-gui.cmd, this leaves nothing on screen: braid runs hidden in
' the background and braid.js opens the control-panel window itself once it's
' listening (--open). To stop braid, use the "Quit braid" button in the GUI
' or end the node process from Task Manager.
Option Explicit
Dim shell, fso, here, nodeExe, portable, flags, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' "/startup" (used by the Start-with-Windows registry entry) starts braid
' quietly in the background without opening the control panel.
flags = " --open"
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "/startup" Then flags = ""
Next

' Prefer the portable Node if present, else whatever "node" is on PATH.
portable = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\node-v24.18.0-win-x64\node.exe"
If fso.FileExists(portable) Then
  nodeExe = portable
Else
  nodeExe = "node"
End If

' Run hidden (0), do not wait (False). braid.js --open opens the browser when
' the server is ready, and if a braid is already running it just opens the GUI.
shell.Run """" & nodeExe & """ """ & here & "\bin\braid.js""" & flags, 0, False
