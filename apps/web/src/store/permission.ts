import { create } from 'zustand';
import type { ToolPreview } from '../lib/types';

/**
 * 폴더 작업 권한 단계 (Claude Code 의 권한 모드처럼). 내 브라우저에서 AI 의 파일 작업을 어디까지 물어볼지 정한다.
 * 이 설정은 이 브라우저에만 기억되고, 서버는 알지 못한다 (파일 작업은 어차피 내 브라우저가 실행하므로).
 */
export type PermissionMode = 'readonly' | 'ask' | 'edits' | 'auto';

export const PERMISSION_OPTIONS: { id: PermissionMode; label: string; description: string }[] = [
  { id: 'readonly', label: '읽기만', description: '파일을 보기만 해요. 만들기·고치기·지우기·명령 실행은 모두 막아요' },
  { id: 'ask', label: '매번 물어보기', description: '파일을 바꾸거나 명령을 실행하기 전에 매번 허용을 물어요 (기본)' },
  { id: 'edits', label: '고치기는 자동', description: '만들기·고치기·옮기기는 묻지 않고, 지우기와 명령 실행은 물어요' },
  { id: 'auto', label: '모두 자동', description: '묻지 않고 진행해요. 폴더 통째로 지우기와 위험해 보이는 명령만 물어요' },
];

const KEY = 'folder-permission';

function read(): PermissionMode {
  try {
    const v = localStorage.getItem(KEY);
    return PERMISSION_OPTIONS.some((o) => o.id === v) ? (v as PermissionMode) : 'ask';
  } catch {
    return 'ask';
  }
}

interface PermissionStore {
  mode: PermissionMode;
  select(mode: PermissionMode): void;
}

export const usePermission = create<PermissionStore>((set) => ({
  mode: read(),
  select(mode) {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* 기억하지 못해도 지금 화면에서는 적용된다 */
    }
    set({ mode });
  },
}));

/**
 * 자동 모드에서도 꼭 물어볼 명령인지 (대충 훑는 검사라 완벽하지 않다 — 스크립트 안의 내용까지는 못 본다).
 * 인터넷으로 내려받기·보내기, 지우기, 시스템 설정, 배포, 작업 폴더 밖을 가리키는 경로 등.
 */
const RISKY_COMMAND = new RegExp(
  [
    // 인터넷 내려받기·보내기, 원격 접속
    String.raw`\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|certutil|bitsadmin|scp|ssh|sftp|ftp|nc|ncat|telnet)\b`,
    // 받은 글을 바로 실행
    String.raw`\|\s*(sh|bash|zsh|iex|powershell|pwsh|cmd)\b`,
    // 지우기·시스템 조작·권한 바꾸기
    String.raw`\b(rm|del|erase|rd|rmdir|remove-item|format|diskpart|shutdown|reboot|taskkill|kill|pkill|sudo|su|runas|chmod|chown|icacls|takeown|reg|regedit|schtasks|sc|setx|net|netsh|attrib|mklink|ln)\b`,
    // 되돌리기 어려운 git·배포
    String.raw`\bgit\s+(push|remote|config|clean|reset\s+--hard)\b`,
    String.raw`\b(npm|yarn|pnpm)\s+(publish|login|adduser)\b`,
    String.raw`-enc(odedcommand)?\b`,
    // 작업 폴더 밖을 가리키는 경로
    String.raw`\.\.[\\/]`,
    String.raw`\b[a-z]:\\`,
    String.raw`\s/(etc|usr|bin|var|root|home|mnt)\b`,
    String.raw`~[\\/]|\$HOME|%userprofile%|%appdata%|%systemroot%`,
  ].join('|'),
  'i',
);

export const isRiskyCommand = (command: string) => RISKY_COMMAND.test(command);

export type Verdict = 'deny' | 'ask' | 'auto';

/** 허용이 필요한 파일 작업·명령 하나를 이 단계에서 어떻게 처리할지 */
export function approvalFor(mode: PermissionMode, preview: ToolPreview): Verdict {
  if (mode === 'readonly') return 'deny';
  if (mode === 'ask') return 'ask';
  if (preview.kind === 'run') return mode === 'auto' && !isRiskyCommand(preview.command) ? 'auto' : 'ask';
  if (preview.kind === 'delete') return mode === 'auto' && !preview.isDir ? 'auto' : 'ask';
  return 'auto';
}
