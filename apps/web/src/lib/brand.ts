// 사이트 이름은 여기와 index.html 의 <title> 만 바꾸면 된다.
export const APP_NAME = '로컬 챗';

// 서버 MAX_MESSAGE_CHARS 와 맞춰 두는 입력 길이 제한 (서버가 최종 검사한다)
export const MAX_MESSAGE_CHARS = 8000;

// 새 채팅 화면의 입력창 아래 버튼 (label 은 버튼 글자, text 는 실제로 보내는 질문)
export const SUGGESTIONS = [
  { label: '💻 코드 작성', text: '파이썬으로 피보나치 수열을 구하는 함수를 작성해 줘' },
  { label: '📚 개념 설명', text: '리액트에서 useEffect 는 언제 쓰는 거야?' },
  { label: '✍️ 글쓰기', text: '자기소개서 첫 문장을 더 매력적으로 쓰는 방법을 알려줘' },
  { label: '🍽️ 일상', text: '오늘 저녁 메뉴를 추천해 줘' },
];
