; Kiosko for Windows: per-user installer (no administrator needed).
; Built by scripts/build-windows-installer.mjs:
;   ISCC /DVersion=0.2.0 /DStage=<folder with node.exe, kiosko.cmd, app\...> /O<out> installer\kiosko.iss
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Stage
  #error Stage (the folder to install) is required: /DStage=...
#endif

[Setup]
AppId={{D4ED10A6-0FD7-4FAC-BFF3-0C49D7EE4BEF}
AppName=Kiosko
AppVersion={#Version}
AppVerName=Kiosko {#Version}
AppPublisher=Kiosko
AppPublisherURL=https://kioskolcd.dev
AppSupportURL=https://github.com/kiosko-lcd/kiosko/issues
VersionInfoVersion={#Version}
DefaultDirName={autopf}\Kiosko
DefaultGroupName=Kiosko
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Kiosko-Setup-{#Version}-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile={#Stage}\LICENSE
InfoAfterFile={#Stage}\notes.txt
ChangesEnvironment=yes
UninstallDisplayName=Kiosko
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "service"; Description: "Start Kiosko in the background when I sign in to Windows"; GroupDescription: "Kiosko:"
Name: "path"; Description: "Add the ""kiosko"" command to PATH"; GroupDescription: "Kiosko:"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Kiosko"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-kiosko.vbs"""; WorkingDir: "{app}"; Comment: "Start Kiosko and open the editor"

[Run]
Filename: "{app}\kiosko.cmd"; Parameters: "service install"; Flags: runhidden waituntilterminated; Tasks: service; StatusMsg: "Starting Kiosko..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-kiosko.vbs"""; Flags: postinstall nowait skipifsilent; Description: "Open the Kiosko editor"

[UninstallRun]
Filename: "{app}\kiosko.cmd"; Parameters: "service uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "KioskoServiceUninstall"

[Code]
const
  EnvKey = 'Environment';

function NeedsPathEntry(Dir: string): Boolean;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Result := True
  else
    Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') = 0;
end;

procedure AddToPath(Dir: string);
var
  Paths: string;
begin
  if not NeedsPathEntry(Dir) then Exit;
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromPath(Dir: string);
var
  Paths: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Exit;
  P := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';');
  if P = 0 then Exit;
  Delete(Paths, P, Length(Dir) + 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

{ An older Kiosko may be running from this folder: stop its service before the files are replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  if FileExists(ExpandConstant('{app}\kiosko.cmd')) then
    Exec(ExpandConstant('{app}\kiosko.cmd'), 'service uninstall', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('path') then
    AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;
