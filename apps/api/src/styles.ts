import { pool } from './db.js';

/** 응답 스타일: 모든 대화의 시스템 프롬프트에 덧붙는 말투·형식 지침 */
export interface StylePreset {
  id: string;
  name: string;
  description: string;
  instruction: string;
}

/** 기본 제공 스타일. 사용자는 이걸 골라 쓰거나, 복사해서 자기 스타일을 만들 수 있다 */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'default',
    name: '기본',
    description: '상황에 맞춰 균형 있게 답해요',
    instruction: '',
  },
  {
    id: 'concise',
    name: '간결하게',
    description: '핵심만 짧게 답해요',
    instruction:
      '답변은 짧고 핵심만 담는다. 인사말, 질문 되풀이, 불필요한 서론과 맺음말은 쓰지 않는다. ' +
      '여러 항목은 짧은 목록으로 정리하고, 사용자가 자세히 물어볼 때만 길게 설명한다.',
  },
  {
    id: 'explanatory',
    name: '자세히 설명',
    description: '배경과 이유까지 차근차근 풀어 줘요',
    instruction:
      '개념을 단계별로 차근차근 풀어서 설명한다. 왜 그런지 이유와 배경을 함께 말하고, 이해를 돕는 예시를 든다. ' +
      '전문 용어는 처음 나올 때 쉬운 말로 풀어 준다. 마지막에 핵심을 한두 줄로 요약한다.',
  },
  {
    id: 'learning',
    name: '학습 도우미',
    description: '정답 대신 스스로 풀도록 이끌어 줘요',
    instruction:
      '선생님처럼 사용자가 스스로 이해하도록 돕는다. 문제를 물으면 정답을 바로 알려 주지 말고, ' +
      '생각할 거리와 단계별 힌트를 먼저 준다. 사용자가 답을 내면 맞았는지 확인하고 틀린 부분을 짚어 준다. ' +
      '사용자가 정답을 직접 요청하면 그때 알려 준다.',
  },
  {
    id: 'formal',
    name: '격식 있게',
    description: '보고서·업무용 문체로 답해요',
    instruction:
      '업무 문서나 보고서에 어울리는 격식 있는 문체(합니다체)로 쓴다. 감탄사, 이모지, 구어체 표현은 쓰지 않는다. ' +
      '제목과 번호 목록으로 구조를 분명하게 하고, 결론을 먼저 쓴다.',
  },
];

export const MAX_CUSTOM_STYLES = 10;

export const findPreset = (id: string) => STYLE_PRESETS.find((p) => p.id === id);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 사용자가 고른 스타일의 이름과 지침 (없어졌으면 기본 스타일) */
export async function resolveStyle(userId: string, styleId: string): Promise<{ name: string; instruction: string }> {
  const preset = findPreset(styleId);
  if (preset) return preset;
  if (UUID.test(styleId)) {
    const { rows } = await pool.query<{ name: string; instruction: string }>(
      'select name, instruction from user_styles where id = $1 and user_id = $2',
      [styleId, userId],
    );
    if (rows[0]) return rows[0];
  }
  return STYLE_PRESETS[0]!;
}

/** 이 사용자가 고를 수 있는 스타일인지 (기본 제공 또는 자기 스타일) */
export async function isSelectableStyle(userId: string, styleId: string): Promise<boolean> {
  if (findPreset(styleId)) return true;
  if (!UUID.test(styleId)) return false;
  const { rowCount } = await pool.query('select 1 from user_styles where id = $1 and user_id = $2', [styleId, userId]);
  return (rowCount ?? 0) > 0;
}
