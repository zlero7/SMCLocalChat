import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SparkIcon } from '../components/Icons';
import { api } from '../lib/api';
import { APP_NAME } from '../lib/brand';

const EFFECTIVE = '2026년 10월 15일';

function useContact() {
  const [email, setEmail] = useState('');
  useEffect(() => {
    api<{ contactEmail?: string }>('/auth/options', { noRefresh: true })
      .then((o) => setEmail(o.contactEmail ?? ''))
      .catch(() => {});
  }, []);
  return email;
}

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm text-sand-500 hover:text-sand-800 dark:hover:text-sand-200">
        <SparkIcon size={18} className="text-clay-500" />
        {APP_NAME}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-sand-500">시행일: {EFFECTIVE}</p>
      <div className="mt-6 space-y-6 text-[15px] leading-7 text-sand-800 dark:text-sand-200">{children}</div>
      <p className="mt-10 border-t border-sand-200 pt-4 text-sm text-sand-500 dark:border-sand-700">
        <Link to="/privacy" className="hover:underline">
          개인정보 처리방침
        </Link>
        {' · '}
        <Link to="/terms" className="hover:underline">
          이용약관
        </Link>
      </p>
    </div>
  );
}

const H = ({ children }: { children: ReactNode }) => <h2 className="mb-2 text-lg font-semibold">{children}</h2>;
const Ul = ({ children }: { children: ReactNode }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>;

export function Privacy() {
  const contact = useContact();
  return (
    <LegalShell title="개인정보 처리방침">
      <p>
        {APP_NAME}(이하 "이 사이트")은 개인이 운영하는 비영리 AI 채팅 서비스예요. 이 문서는 어떤 정보를 어떻게 쓰고 지우는지 설명해요. 문의:{' '}
        {contact ? (
          <a href={`mailto:${contact}`} className="text-clay-600 underline dark:text-clay-400">
            {contact}
          </a>
        ) : (
          '운영자에게 직접 문의해 주세요'
        )}
      </p>

      <section>
        <H>1. 모으는 정보</H>
        <Ul>
          <li>계정: 이메일, 닉네임, 암호화한 비밀번호(구글로만 가입하면 비밀번호는 없어요), 구글로 로그인했다면 구글 계정 식별자</li>
          <li>대화: 내가 보낸 질문과 AI 의 답변, 붙인 파일과 이미지, 개인 지침, AI 가 적어 둔 기억, 프로젝트와 예약 작업</li>
          <li>사용 기록: 언제 얼마나(토큰 수) 썼는지. 사용량 제한을 위해서만 써요</li>
          <li>접속 기록: 서버에 접속 시각과 요청 주소가 남을 수 있어요</li>
          <li>쿠키: 로그인을 유지하는 쿠키 1개만 써요. 광고나 추적 쿠키는 없어요</li>
        </Ul>
      </section>

      <section>
        <H>2. 어디서 처리하나요</H>
        <p>
          답변은 운영자의 컴퓨터에서 직접 돌리는 언어 모델이 만들어요. 대화를 OpenAI, Google 같은 외부 AI 회사에 보내지 않아요. 단, 웹 검색을 켜면
          검색어가 검색 사이트로 전달돼요. 데이터는 운영자의 컴퓨터에 저장되고, 하루 한 번 같은 컴퓨터의 다른 디스크에 백업돼요(14일 보관).
        </p>
      </section>

      <section>
        <H>3. Gmail 연결 (선택 사항)</H>
        <Ul>
          <li>설정에서 직접 연결한 경우에만 써요. 요청하는 권한은 메일을 <b>읽기만 하는 권한(gmail.readonly)</b> 하나예요. 보내기·지우기·고치기는 못 해요.</li>
          <li>내가 "메일 찾아줘"처럼 요청할 때만 메일에 접근하고, 찾은 내용은 답변을 만들려고 이 사이트의 모델에게 전달돼요.</li>
          <li>메일을 따로 복사해 저장하지 않아요. 다만 AI 가 답변에 인용한 내용은 그 대화에 남아요. 연결 정보(갱신 토큰)는 암호화해서 저장해요.</li>
          <li>설정에서 연결을 끊으면 구글에 권한을 돌려주고 저장된 연결 정보를 지워요. 구글 계정 설정에서도 언제든 접근을 거둘 수 있어요.</li>
          <li>메일 내용은 광고, 분석, 판매, 제3자 제공, 모델 학습에 쓰지 않아요.</li>
          <li lang="en">
            This site's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited
            Use requirements.
          </li>
        </Ul>
      </section>

      <section>
        <H>4. 디스코드 봇 (선택 사항)</H>
        <Ul>
          <li>설정에서 직접 연결한 경우에만 써요. 내가 입력한 <b>봇 토큰</b>은 암호화해서 저장하고, 화면과 응답에 다시 보여 주지 않아요.</li>
          <li>봇에게 보낸 디스코드 메시지와 첨부한 파일(이미지·문서)은 답을 만들려고 이 사이트의 모델에게 전달돼요. 첨부 파일은 읽을 때만 쓰고 서버에 저장하지 않아요. 질문과 답변은 저장하지 않고, 같은 채널의 이어지는 대화를 위해 메모리에 30분 동안만 둬요(파일은 이름만).</li>
          <li>봇을 쓰는 채널에서는 봇 주인이 켠 경우 그 채널에 올라오는 모든 글을 읽고 답해요(디스코드의 메시지 내용 권한). 지정하지 않은 채널의 글은 읽지 않아요. 봇이 만든 파일은 그 대화에만 올라가요.</li>
          <li>봇이 쓴 양은 봇을 연결한 사람의 사용량으로 기록돼요. 봇을 부른 다른 디스코드 사용자의 정보는 저장하지 않아요.</li>
          <li>설정에서 연결을 끊거나 계정을 삭제하면 저장된 봇 토큰이 지워져요.</li>
        </Ul>
      </section>

      <section>
        <H>5. 보관과 삭제</H>
        <Ul>
          <li>설정 → 계정 → <b>계정 삭제</b>를 누르면 내 대화, 파일, 기억, 예약, 프로젝트, 공유 링크와 Gmail·디스코드 봇 연결이 모두 지워져요. 되돌릴 수 없어요.</li>
          <li>대화를 지우면 목록에서 사라지지만 일정 기간 서버에 남아 있을 수 있어요. 완전히 지우려면 계정 삭제를 쓰세요.</li>
          <li>백업에 남은 사본은 최대 14일 안에 사라져요.</li>
          <li>사용 기록은 누구의 것인지 연결을 끊고 전체 통계로만 남아요.</li>
        </Ul>
      </section>

      <section>
        <H>6. 다른 사람에게 주나요</H>
        <p>법령에 따른 요구가 있는 경우를 빼고 정보를 제3자에게 팔거나 주지 않아요. 내가 만든 공유 링크를 아는 사람은 그 대화를 볼 수 있으니 조심해 주세요.</p>
      </section>

      <section>
        <H>7. 보안</H>
        <p>
          접속은 HTTPS 로 암호화돼요. 비밀번호는 복원할 수 없는 방식으로 저장해요. 그래도 어떤 시스템도 완벽히 안전하지는 않으니, 민감한 정보(주민번호,
          금융 정보 등)는 올리지 말아 주세요.
        </p>
      </section>

      <section>
        <H>8. 바뀔 때</H>
        <p>내용이 바뀌면 이 페이지에 시행일과 함께 올려요.</p>
      </section>
    </LegalShell>
  );
}

export function Terms() {
  const contact = useContact();
  return (
    <LegalShell title="이용약관">
      <section>
        <H>1. 서비스</H>
        <p>
          {APP_NAME}은 개인이 운영하는 무료 AI 채팅 서비스예요. 초대받은 사람이 쓸 수 있고, 사용량에 제한이 있어요. 운영자의 사정으로 예고 없이 느려지거나
          멈추거나 바뀔 수 있어요.
        </p>
      </section>
      <section>
        <H>2. AI 답변</H>
        <p>AI 는 틀린 내용을 그럴듯하게 말할 수 있어요. 의료·법률·금융처럼 중요한 결정은 꼭 다른 근거로 다시 확인해 주세요. 답변을 쓴 책임은 쓰는 사람에게 있어요.</p>
      </section>
      <section>
        <H>3. 지켜 주세요</H>
        <Ul>
          <li>다른 사람의 계정이나 연결 코드를 쓰지 않아요</li>
          <li>불법적이거나 다른 사람을 해치는 내용을 만들게 하지 않아요</li>
          <li>서비스를 일부러 과도하게 써서 다른 사람이 못 쓰게 하지 않아요</li>
          <li>"내 컴퓨터 폴더"와 "프로그램 실행"은 내 컴퓨터에서 내가 허용한 범위에서만 동작해요. 허용하기 전에 내용을 읽어 보세요</li>
        </Ul>
      </section>
      <section>
        <H>4. 계정</H>
        <p>약관을 어기거나 서비스에 문제를 일으키면 운영자가 계정을 막거나 지울 수 있어요. 내가 원하면 언제든 설정에서 계정을 삭제할 수 있어요.</p>
      </section>
      <section>
        <H>5. 책임의 범위</H>
        <p>무료로 제공하는 서비스라 안정성, 정확성, 데이터 보존을 보장하지 않아요. 중요한 내용은 따로 보관해 주세요.</p>
      </section>
      <section>
        <H>6. 문의</H>
        <p>
          {contact ? (
            <a href={`mailto:${contact}`} className="text-clay-600 underline dark:text-clay-400">
              {contact}
            </a>
          ) : (
            '운영자에게 직접 문의해 주세요'
          )}
        </p>
      </section>
    </LegalShell>
  );
}
