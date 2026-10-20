'use strict';
/**
 * 生成 start.bat
 *
 * 为什么用脚本生成而不是直接写文件：
 *  .bat 必须满足三个硬条件，否则 CMD 会把整个脚本解析错乱
 *    1) 换行必须是 CRLF
 *    2) 内容只能是 ASCII（中文交给 node 输出，chcp 65001 之后才安全）
 *    3) 不能出现任何 0x08 / 0x0A / 0x0B 等被误当成控制字符的字节
 *  用代码生成可以保证字节精确可控，也避免手工编辑时再次踩坑。
 *
 * 用法：node tools/gen-startbat.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const LINES = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul 2>nul',
  'title ROMKit',
  'cd /d "%~dp0"',
  '',
  'if not exist "%~dp0data" mkdir "%~dp0data"',
  '',
  'rem ---- locate node.exe ----',
  'set "NODE_EXE="',
  'for /f "delims=" %%i in (\'where node 2^>nul\') do if not defined NODE_EXE set "NODE_EXE=%%i"',
  'if defined NODE_EXE goto HAVE_NODE',
  '',
  'for %%p in ("%ProgramFiles%\\nodejs\\node.exe" "%ProgramW6432%\\nodejs\\node.exe" "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" "%APPDATA%\\nvm\\node.exe" "%USERPROFILE%\\scoop\\apps\\nodejs\\current\\node.exe") do if not defined NODE_EXE if exist "%%~p" set "NODE_EXE=%%~p"',
  'if defined NODE_EXE goto HAVE_NODE',
  '',
  'if exist "%USERPROFILE%\\.workbuddy\\binaries\\node\\versions" (',
  '  for /d %%d in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*") do if not defined NODE_EXE if exist "%%d\\node.exe" set "NODE_EXE=%%d\\node.exe"',
  ')',
  'if defined NODE_EXE goto HAVE_NODE',
  'goto NO_NODE',
  '',
  ':HAVE_NODE',
  'echo [%date% %time%] node=%NODE_EXE%>>"%~dp0data\\start.log"',
  'echo.',
  'echo   ROMKit  local service',
  'echo   node: %NODE_EXE%',
  'echo.',
  'echo   Keep this window OPEN while using ROMKit.',
  'echo   Close it or press Ctrl+C to quit.',
  'echo.',
  '"%NODE_EXE%" server.js --open',
  'set "CODE=%ERRORLEVEL%"',
  'echo.',
  'echo   ROMKit stopped. exit code = %CODE%',
  'echo [%date% %time%] stopped code=%CODE%>>"%~dp0data\\start.log"',
  'pause',
  'exit /b %CODE%',
  '',
  ':NO_NODE',
  'echo [%date% %time%] node not found>>"%~dp0data\\start.log"',
  'echo.',
  'echo   [ROMKit] Node.js was not found on this computer.',
  'echo.',
  'echo   Please install Node.js 18 or newer, then run this file again:',
  'echo     https://nodejs.org/',
  'echo.',
  'pause',
  'exit /b 1',
  '',
];

const content = LINES.join('\r\n');
const out = path.join(ROOT, 'start.bat');
fs.writeFileSync(out, content, 'ascii');

// 自检：不允许出现除 CRLF 之外的换行，也不允许控制字符
const bad = [];
for (let i = 0; i < content.length; i++) {
  const c = content.charCodeAt(i);
  if (c === 10 && content.charCodeAt(i - 1) !== 13) bad.push('LF@' + i);
  if (c === 8 || c === 11 || c === 12) bad.push('CTRL@' + i + '=' + c);
  if (c > 126) bad.push('NONASCII@' + i);
}
console.log('written:', out, fs.statSync(out).size, 'bytes');
console.log(bad.length ? 'PROBLEM: ' + bad.slice(0, 5).join(', ') : 'byte check: OK (CRLF + ASCII only)');
