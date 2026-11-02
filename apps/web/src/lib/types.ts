export interface User {
  id: string;
  email: string;
  nickname: string;
  role: 'user' | 'admin';
  customInstruction: string;
  /** 고른 응답 스타일 (기본 제공 스타일 id 또는 내 스타일 id) */
  styleId: string;
  /** 기억 기능을 쓰는지 */
  memoryEnabled: boolean;
  createdAt: string;
}

/** 5시간 사용량 */
export interface Usage {
  limit: number;
  /** 관리자가 이 사용자에게 따로 정한 값이면 true */
  custom: boolean;
  used: number;
  /** 지금 사용량이 초기화되는 시각. null 이면 아직 시작 전(다음 메시지부터 5시간) */
  resetAt: string | null;
  windowHours: number;
}

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  instruction: string;
}

export interface CustomStyle {
  id: string;
  name: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  nickname: string;
  role: 'user' | 'admin';
  createdAt: string;
  lastActiveAt: string | null;
  usage: Usage;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 예약 작업이 만든 대화 */
  scheduled?: boolean;
  /** 아직 열어 보지 않은 새 결과 */
  unread?: boolean;
  /** 속한 프로젝트 (없으면 null) */
  projectId?: string | null;
}

export type ScheduleRepeat = 'once' | 'daily' | 'weekly';

/** 예약 작업: 정해 둔 시각에 지시를 AI 에게 보내고 결과를 새 대화로 남긴다 */
export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  /** null 이면 그때의 기본 모델 */
  model: string | null;
  /** null 이면 내가 고른 기본 스타일 */
  styleId: string | null;
  repeat: ScheduleRepeat;
  /** "HH:MM" */
  time: string;
  /** 매주 반복의 요일들 (0=일 ~ 6=토) */
  weekdays: number[];
  /** 한 번 실행의 날짜 "YYYY-MM-DD" */
  date: string | null;
  timezone: string;
  enabled: boolean;
  /** 실행할 때 웹 검색을 쓸지 */
  webSearch: boolean;
  /** 실행할 때 Gmail 을 쓸지 */
  gmail: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: 'done' | 'error' | 'skipped' | null;
  lastMessage: string | null;
  lastConversationId: string | null;
  running: boolean;
  createdAt: string;
}

export type ScheduleInput = Pick<
  Schedule,
  'title' | 'prompt' | 'model' | 'styleId' | 'repeat' | 'time' | 'weekdays' | 'date' | 'timezone' | 'enabled' | 'webSearch' | 'gmail'
>;

export type MessageStatus = 'done' | 'stopped' | 'error';

export interface ServerMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: MessageStatus;
  /** 답변을 만든 모델 (사용자 메시지는 null) */
  model: string | null;
  /** 답변을 만들며 AI 가 한 파일 작업 */
  tools: ToolStep[];
  /** 사용자 메시지에 붙인 파일 */
  attachments?: Attachment[];
  createdAt: string;
}

/** 메시지에 붙인 파일 (이미지 또는 글 문서) */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'document';
  mime: string;
  size: number;
}

/** AI 가 쓴 도구 하나 (파일 작업, 웹 검색, 페이지 읽기) */
export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** running: 서버가 실행 중 (웹 도구) */
  status: 'ok' | 'error' | 'denied' | 'running';
  summary: string;
  /** 웹 검색이 찾은 출처 */
  sources?: { title: string; url: string }[];
}

/** 파일을 바꾸기 전에 허용을 묻는 미리보기 */
export type ToolPreview =
  | { kind: 'write'; path: string; exists: boolean; content: string; truncated: boolean }
  | { kind: 'edit'; path: string; oldText: string; newText: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete'; path: string; isDir: boolean }
  | { kind: 'move'; path: string; to: string; isDir: boolean; copy: boolean }
  | { kind: 'run'; path: string; command: string; timeoutSec: number };

/** 서버가 보낸 도구 실행 요청 (사용자 PC 폴더에서 브라우저가 실행한다) */
export interface ToolExec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 쓰기 작업이라 사용자 허용이 필요한지 */
  needsApproval: boolean;
}

export interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  preview: ToolPreview;
}


export interface ConversationDetail {
  conversation: Conversation;
  messages: ServerMessage[];
  generating: boolean;
  /** 대화가 길어서 여기(이 메시지)까지는 요약해서 기억한다. 없으면 null */
  summarizedThrough?: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ServerStatus {
  /** 기본 모델 */
  model: string;
  models: ModelOption[];
  online: boolean;
  active: number;
  waiting: number;
  concurrency: number;
  /** 사이트에 웹 검색이 설정돼 있는지 */
  webSearch?: boolean;
}

/** 프로젝트: 대화를 주제별로 묶고 공통 지침과 자료를 준다 */
export interface Project {
  id: string;
  name: string;
  description: string;
  /** 이 프로젝트의 모든 대화에 들어가는 지침 */
  instructions: string;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  fileCount: number;
}

/** 프로젝트 자료 (문서) */
export interface ProjectFile extends Attachment {
  /** 뽑아 둔 글자 수 */
  chars: number;
  createdAt: string;
}

export interface ProjectDetail {
  project: Project;
  files: ProjectFile[];
  conversations: { id: string; title: string; updatedAt: string }[];
}

/** 기억: 대화에서 알게 된 사용자에 대한 사실 */
export interface Memory {
  id: string;
  content: string;
  /** 이 기억을 만든 대화 (직접 적었으면 null) */
  conversationId: string | null;
  createdAt: string;
}
