; Установщик MUSICH для Windows (Inno Setup 6). Собирается из deploy/windows/build.mjs:
;   node deploy/windows/build.mjs
; Ставит программу в Program Files, запускает сервер в фоне при старте компьютера (service.ps1 → Планировщик заданий),
; открывает порт для домашней сети. Данные — в %ProgramData%\MUSICH, удаление программы их не трогает.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef Stage
  #define Stage "out\stage"
#endif

[Setup]
AppId={{7E0F1C2A-5B8D-4C3E-9A61-2D4F8B9C0E11}
AppName=MUSICH
AppVersion={#AppVersion}
AppVerName=MUSICH {#AppVersion}
AppPublisher=rozev-and
AppPublisherURL=https://github.com/rozev-and/Musich
AppSupportURL=https://github.com/rozev-and/Musich
DefaultDirName={autopf}\MUSICH
DefaultGroupName=MUSICH
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=out
OutputBaseFilename=MUSICH-Setup-{#AppVersion}
SetupIconFile={#Stage}\musich.ico
UninstallDisplayIcon={app}\musich.ico
UninstallDisplayName=MUSICH
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"
Name: "ar"; MessagesFile: "compiler:Languages\Arabic.isl"
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
ru.Starting=Запускаю сервер MUSICH…
en.Starting=Starting the MUSICH server…
it.Starting=Avvio del server MUSICH…
de.Starting=MUSICH-Server wird gestartet…
fr.Starting=Démarrage du serveur MUSICH…
ar.Starting=جارٍ تشغيل خادم MUSICH…
ja.Starting=MUSICH サーバーを起動しています…
ru.Stopping=Останавливаю сервер MUSICH…
en.Stopping=Stopping the MUSICH server…
it.Stopping=Arresto del server MUSICH…
de.Stopping=MUSICH-Server wird angehalten…
fr.Stopping=Arrêt du serveur MUSICH…
ar.Stopping=جارٍ إيقاف خادم MUSICH…
ja.Stopping=MUSICH サーバーを停止しています…
ru.Open=Открыть MUSICH
en.Open=Open MUSICH
it.Open=Apri MUSICH
de.Open=MUSICH öffnen
fr.Open=Ouvrir MUSICH
ar.Open=افتح MUSICH
ja.Open=MUSICH を開く

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[INI]
; ярлык открывает интерфейс в браузере
Filename: "{app}\MUSICH.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:2290"

[Icons]
; своё окно, как у программы: Edge в режиме приложения (без адресной строки и вкладок; Edge есть в каждой Windows 10/11,
; браузер по умолчанию при этом любой). Нет Edge — ярлык открывает страницу в браузере по умолчанию
Name: "{group}\MUSICH"; Filename: "{code:OpenExe}"; Parameters: "{code:OpenArgs}"; IconFilename: "{app}\musich.ico"
Name: "{autodesktop}\MUSICH"; Filename: "{code:OpenExe}"; Parameters: "{code:OpenArgs}"; IconFilename: "{app}\musich.ico"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service.ps1"" install"; Flags: runhidden waituntilterminated; StatusMsg: "{cm:Starting}"
Filename: "{code:OpenExe}"; Parameters: "{code:OpenArgs}"; Description: "{cm:Open}"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\service.ps1"" uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "MusichService"; StatusMsg: "{cm:Stopping}"

[UninstallDelete]
Type: files; Name: "{app}\MUSICH.url"

[Code]
function EdgePath(): String;
begin
  Result := ExpandConstant('{commonpf32}\Microsoft\Edge\Application\msedge.exe');
  if not FileExists(Result) then Result := ExpandConstant('{commonpf64}\Microsoft\Edge\Application\msedge.exe');
  if not FileExists(Result) then Result := '';
end;

function OpenExe(Param: String): String;
begin
  Result := EdgePath();
  if Result = '' then Result := ExpandConstant('{app}\MUSICH.url');
end;

function OpenArgs(Param: String): String;
begin
  if EdgePath() <> '' then Result := '--app=http://localhost:2290' else Result := '';
end;

// обновление поверх старой версии: сначала остановить сервер, иначе файлы заняты
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script: String;
  Rc: Integer;
begin
  Script := ExpandConstant('{app}\service.ps1');
  if FileExists(Script) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" stop', '', SW_HIDE, ewWaitUntilTerminated, Rc);
  Result := '';
end;
