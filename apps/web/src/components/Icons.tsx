import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const MenuIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Base>
);
export const CloseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Base>
);
export const SendIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Base>
);
export const StopIcon = (p: IconProps) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);
export const TrashIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
  </Base>
);
export const PencilIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20l4-1 11-11a2.1 2.1 0 00-3-3L5 16l-1 4zM14 7l3 3" />
  </Base>
);
export const CopyIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 012-2h9" />
  </Base>
);
export const CheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Base>
);
export const ChevronIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 6l6 6-6 6" />
  </Base>
);
export const SunIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Base>
);
export const MoonIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />
  </Base>
);
export const MonitorIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Base>
);
export const SettingsIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
    <circle cx="15" cy="8" r="2" />
    <circle cx="9" cy="16" r="2" />
  </Base>
);
export const LogoutIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
  </Base>
);
export const ChatIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 6.5A2.5 2.5 0 017.5 4h9A2.5 2.5 0 0119 6.5v6a2.5 2.5 0 01-2.5 2.5H11l-4 3.5V15a2 2 0 01-2-2z" />
  </Base>
);
export const FolderIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </Base>
);
export const FileIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </Base>
);
export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </Base>
);
export const UploadIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </Base>
);
export const DownloadIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
  </Base>
);
/** 사이트 로고 겸 인사말 장식 (방사형 별) */
export const SparkIcon = (p: IconProps) => (
  <Base strokeWidth={2.4} {...p}>
    <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
  </Base>
);
export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 9l6 6 6-6" />
  </Base>
);
/** 응답 스타일 (펜촉) */
export const StyleIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 19l7-7 2 2-7 7-2-2zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.6 7.6" />
    <circle cx="11" cy="11" r="2" />
  </Base>
);
/** 관리자 (방패) */
export const ShieldIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Base>
);
/** 사용량 (게이지) */
export const GaugeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 18a9 9 0 1115 0" />
    <path d="M12 14l4-5" />
  </Base>
);
/** 예약 작업 (시계) */
export const ClockIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Base>
);
/** 지금 실행 (재생) */
export const PlayIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 5l12 7-12 7V5z" />
  </Base>
);
/** 알림 (종) */
export const BellIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16z" />
    <path d="M10 20.5a2 2 0 004 0" />
  </Base>
);
/** 웹 검색 (지구) */
export const GlobeIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
  </Base>
);
/** 페이지 읽기 (링크) */
export const LinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
  </Base>
);
/** 다시 만들기 (돌아가는 화살표) */
export const RefreshIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 11a8 8 0 10-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Base>
);
/** 공유 */
export const ShareIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5" />
  </Base>
);
/** 더 보기 (점 세 개) */
export const MoreIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Base>
);
/** 첨부 (클립) */
export const PaperclipIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20.5 11.5l-8.3 8.3a5 5 0 01-7.1-7.1l8.3-8.3a3.5 3.5 0 015 5l-8.3 8.3a2 2 0 01-2.8-2.8l7.6-7.6" />
  </Base>
);
/** 기억 (전구) */
export const BulbIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 00-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0012 3z" />
  </Base>
);
/** 프로젝트 (상자) */
export const ProjectIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M3 7v10l9 4 9-4V7" />
    <path d="M12 11v10" />
  </Base>
);
/** 메일 (봉투) */
export const MailIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </Base>
);
