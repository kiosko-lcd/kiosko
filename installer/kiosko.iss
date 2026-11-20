; Kiosko for Windows: per-user installer (no administrator needed).
; Saved as UTF-8 with BOM (Inno Setup reads it as Unicode): it holds Chinese text.
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
ChangesEnvironment=yes
UninstallDisplayName=Kiosko
CloseApplications=force
RestartApplications=no
; The wizard speaks the language of Windows' UI (no language dialog unless none
; matches; /LANG=english|spanish|chinesetraditional|chinesesimplified forces one).
LanguageDetectionMethod=uilanguage
ShowLanguageDialog=auto

[Languages]
; The notes shown after installing are per language (notes*.txt, next to this file;
; UTF-8 with BOM). The Chinese .isl are Inno Setup's unofficial translations,
; vendored from jrsoftware/issrc tag is-6_7_1 (484a38a6), Files/Languages/Unofficial/,
; headers intact; see languages/. Chinese matches by LANGID: zh-TW ($0404) and
; zh-CN ($0804) exactly; other Chinese locales (zh-HK, zh-MO, zh-SG) take the first
; Chinese entry, Traditional.
Name: "english"; MessagesFile: "compiler:Default.isl"; InfoAfterFile: "notes.txt"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"; InfoAfterFile: "notes.es.txt"
Name: "chinesetraditional"; MessagesFile: "languages\ChineseTraditional.isl"; InfoAfterFile: "notes.zh-Hant.txt"
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"; InfoAfterFile: "notes.zh-Hans.txt"

[Messages]
; ChineseTraditional.isl was last updated for Inno Setup 6.1: these are the messages
; added since (downloads, archives, signatures, retry dialog), in Taiwan's wording.
chinesetraditional.ArchiveIncorrectPassword=密碼不正確
chinesetraditional.ArchiveIsCorrupted=壓縮檔已損毀
chinesetraditional.ArchiveUnsupportedFormat=不支援的壓縮檔格式
chinesetraditional.ButtonStopExtraction=停止解壓縮(&S)
chinesetraditional.DownloadingLabel2=正在下載檔案...
chinesetraditional.ErrorDownloading=下載檔案時發生錯誤:
chinesetraditional.ErrorExtracting=解壓縮檔案時發生錯誤:
chinesetraditional.ErrorExtractionAborted=已中止解壓縮
chinesetraditional.ErrorExtractionFailed=解壓縮失敗: %1
chinesetraditional.ExtractingLabel=正在解壓縮檔案...
chinesetraditional.RetryCancelCancel=取消
chinesetraditional.RetryCancelRetry=重試(&T)
chinesetraditional.RetryCancelSelectAction=請選擇動作
chinesetraditional.SourceVerificationFailed=來源檔案驗證失敗: %1
chinesetraditional.StatusDownloadFiles=正在下載檔案...
chinesetraditional.StopExtraction=您確定要停止解壓縮嗎?
chinesetraditional.VerificationFileHashIncorrect=檔案的雜湊值不正確
chinesetraditional.VerificationFileNameIncorrect=檔案名稱不正確
chinesetraditional.VerificationFileSizeIncorrect=檔案大小不正確
chinesetraditional.VerificationFileTagIncorrect=檔案標籤不正確
chinesetraditional.VerificationKeyNotFound=簽章檔「%1」使用了不明的金鑰
chinesetraditional.VerificationSignatureDoesntExist=簽章檔「%1」不存在
chinesetraditional.VerificationSignatureInvalid=簽章檔「%1」無效

[CustomMessages]
english.TaskGroup=Kiosko:
english.TaskService=Start Kiosko in the background when I sign in to Windows
english.TaskPath=Add the "kiosko" command to PATH
english.IconComment=Start Kiosko and open the editor
english.StatusStarting=Starting Kiosko...
english.RunEditor=Open the Kiosko editor
spanish.TaskGroup=Kiosko:
spanish.TaskService=Iniciar Kiosko en segundo plano al iniciar sesión en Windows
spanish.TaskPath=Añadir el comando «kiosko» al PATH
spanish.IconComment=Inicia Kiosko y abre el editor
spanish.StatusStarting=Iniciando Kiosko...
spanish.RunEditor=Abrir el editor de Kiosko
chinesetraditional.TaskGroup=Kiosko:
chinesetraditional.TaskService=登入 Windows 時在背景自動啟動 Kiosko
chinesetraditional.TaskPath=將「kiosko」指令加入 PATH 環境變數
chinesetraditional.IconComment=啟動 Kiosko 並開啟編輯器
chinesetraditional.StatusStarting=正在啟動 Kiosko...
chinesetraditional.RunEditor=開啟 Kiosko 編輯器
chinesesimplified.TaskGroup=Kiosko:
chinesesimplified.TaskService=登录 Windows 时在后台自动启动 Kiosko
chinesesimplified.TaskPath=将“kiosko”命令添加到 PATH 环境变量
chinesesimplified.IconComment=启动 Kiosko 并打开编辑器
chinesesimplified.StatusStarting=正在启动 Kiosko...
chinesesimplified.RunEditor=打开 Kiosko 编辑器

[Tasks]
Name: "service"; Description: "{cm:TaskService}"; GroupDescription: "{cm:TaskGroup}"
Name: "path"; Description: "{cm:TaskPath}"; GroupDescription: "{cm:TaskGroup}"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Kiosko"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-kiosko.vbs"""; WorkingDir: "{app}"; Comment: "{cm:IconComment}"

[Run]
Filename: "{app}\kiosko.cmd"; Parameters: "service install"; Flags: runhidden waituntilterminated; Tasks: service; StatusMsg: "{cm:StatusStarting}"
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-kiosko.vbs"""; Flags: postinstall nowait skipifsilent; Description: "{cm:RunEditor}"

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
