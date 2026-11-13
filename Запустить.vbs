' Запуск Dynamic Wave без окна консоли
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"
CreateObject("WScript.Shell").Run """" & exe & """ """ & dir & """", 0, False
