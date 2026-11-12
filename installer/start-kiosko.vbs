' Starts Kiosko without a console window (if it is not running) and opens the editor.
Option Explicit
Dim sh, fso, here, url, home, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:7420/"

Function IsUp()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 500
  http.open "GET", url, False
  http.send
  IsUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function

If Not IsUp() Then
  home = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Kiosko"
  If Not fso.FolderExists(home) Then fso.CreateFolder home
  sh.Run "cmd.exe /d /s /c """"" & here & "\kiosko.cmd"" start >> """ & home & "\kiosko.log"" 2>&1""", 0, False
  For i = 1 To 30
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
End If
sh.Run url
