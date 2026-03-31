/**
 * ═══════════════════════════════════════════════════════════
 *  안티그래비티 NotebookLM 자동화 동기화 스크립트
 *  nmeditation/scripts/sync.js
 *
 *  워크플로우:
 *  1. Google Drive에서 최신 NotebookLM 오디오 파일 감지
 *  2. 노트북 공유 URL에서 메타데이터 파싱
 *  3. Firebase Firestore 업데이트
 *  4. public/data/meditation.json 로컬 캐시 업데이트
 *
 *  사용법:
 *    node scripts/sync.js              # 오늘 날짜로 동기화
 *    node scripts/sync.js --date 2026-03-31
 *    node scripts/sync.js --all        # 전체 동기화
 *    node scripts/sync.js --auth       # OAuth 토큰 초기 발급
 * ═══════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 환경변수 로드 ──
let dotenv;
try {
    dotenv = await import('dotenv');
    dotenv.config({ path: resolve(ROOT, '.env') });
} catch {
    console.warn('[sync] dotenv 없음 — .env 파일을 직접 확인하세요');
}

const NOTEBOOK_ID = process.env.NOTEBOOKLM_NOTEBOOK_ID || '53e7aa7c-e622-4bb5-a856-6d736dbd5ddd';
const NOTEBOOK_URL = `https://notebooklm.google.com/notebook/${NOTEBOOK_ID}`;
const JSON_PATH = resolve(ROOT, 'public/data/meditation.json');
const TOKENS_PATH = resolve(ROOT, '.gdrive-tokens.json');

// ── CLI 인수 파싱 ──
const args = process.argv.slice(2);
const isAuth = args.includes('--auth');
const isAll = args.includes('--all');
const dateArg = args[args.indexOf('--date') + 1];

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

const TARGET_DATE = dateArg === 'today' || !dateArg ? todayStr() : dateArg;

// ══════════════════════════════════════════════════════════
//  색상 출력 헬퍼
// ══════════════════════════════════════════════════════════
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
};

function log(level, msg) {
    const icons = { info: `${C.blue}ℹ`, ok: `${C.green}✅`, warn: `${C.yellow}⚠`, err: `${C.red}❌`, step: `${C.cyan}→` };
    console.log(`${icons[level] || ''} ${msg}${C.reset}`);
}

function header(msg) {
    console.log(`\n${C.bold}${C.magenta}══ ${msg} ══${C.reset}`);
}

// ══════════════════════════════════════════════════════════
//  Google Drive OAuth2
// ══════════════════════════════════════════════════════════
async function getGoogleAuth() {
    let googleapis;
    try {
        googleapis = await import('googleapis');
    } catch {
        log('err', 'googleapis 패키지가 없습니다. npm install 을 먼저 실행하세요.');
        process.exit(1);
    }

    const { google } = googleapis;
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

    if (!CLIENT_ID || !CLIENT_SECRET) {
        log('warn', '.env에 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET가 없습니다.');
        log('warn', '설정 방법: https://console.cloud.google.com → OAuth 2.0 클라이언트 ID 생성');
        return null;
    }

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

    if (existsSync(TOKENS_PATH)) {
        const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
        oAuth2Client.setCredentials(tokens);
        // Refresh if expired
        if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
            try {
                const { credentials } = await oAuth2Client.refreshAccessToken();
                oAuth2Client.setCredentials(credentials);
                writeFileSync(TOKENS_PATH, JSON.stringify(credentials, null, 2));
                log('ok', 'Google OAuth 토큰 갱신 완료');
            } catch(e) {
                log('warn', `토큰 갱신 실패: ${e.message} — --auth로 재인증 필요`);
            }
        }
        return { auth: oAuth2Client, google };
    }

    return null;
}

async function authorizeGoogle() {
    let googleapis;
    try { googleapis = await import('googleapis'); } catch {
        log('err', 'npm install을 먼저 실행하세요');
        process.exit(1);
    }

    const { google } = googleapis;
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

    if (!CLIENT_ID || !CLIENT_SECRET) {
        log('err', '.env 파일에 GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET을 설정하세요');
        printEnvSetupGuide();
        process.exit(1);
    }

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/drive.readonly',
        ],
    });

    console.log(`\n${C.bold}${C.cyan}[인증 필요]${C.reset}`);
    console.log('아래 URL을 브라우저에서 열어 Google 계정(gt4065c@gmail.com)으로 로그인하세요:\n');
    console.log(`${C.blue}${authUrl}${C.reset}\n`);
    console.log('인증 후 받은 코드를 아래에 입력하세요:');

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    return new Promise((resolve) => {
        rl.question('인증 코드: ', async (code) => {
            rl.close();
            try {
                const { tokens } = await oAuth2Client.getToken(code.trim());
                oAuth2Client.setCredentials(tokens);
                writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
                log('ok', `토큰 저장 완료: ${TOKENS_PATH}`);
                resolve({ auth: oAuth2Client, google });
            } catch(e) {
                log('err', `인증 실패: ${e.message}`);
                process.exit(1);
            }
        });
    });
}

// ══════════════════════════════════════════════════════════
//  Google Drive: NotebookLM 오디오 파일 검색
// ══════════════════════════════════════════════════════════
async function findNotebookLMAudio(auth, google) {
    const drive = google.drive({ version: 'v3', auth });

    header('Google Drive에서 NotebookLM 오디오 검색');

    try {
        // NotebookLM이 생성하는 파일명 패턴으로 검색
        const queries = [
            "name contains 'NotebookLM' and mimeType contains 'audio'",
            "name contains 'Audio Overview' and mimeType contains 'audio'",
            "name contains '묵상' and mimeType contains 'audio'",
            "name contains 'Deep Dive' and mimeType contains 'audio'",
        ];

        const FOLDER_ID = process.env.GDRIVE_AUDIO_FOLDER_ID;
        let allFiles = [];

        for (const q of queries) {
            const fullQuery = FOLDER_ID
                ? `${q} and '${FOLDER_ID}' in parents`
                : q;

            const res = await drive.files.list({
                q: fullQuery,
                fields: 'files(id,name,createdTime,modifiedTime,webViewLink,webContentLink,size)',
                orderBy: 'modifiedTime desc',
                pageSize: 10,
            });

            if (res.data.files?.length) {
                log('ok', `"${q}" → ${res.data.files.length}개 발견`);
                allFiles.push(...res.data.files);
            }
        }

        // 중복 제거
        const seen = new Set();
        allFiles = allFiles.filter(f => {
            if (seen.has(f.id)) return false;
            seen.add(f.id);
            return true;
        });

        // 최신순 정렬
        allFiles.sort((a,b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

        if (!allFiles.length) {
            log('warn', 'Drive에서 NotebookLM 오디오 파일을 찾지 못했습니다.');
            log('warn', '수동으로 오디오 URL을 어드민 패널에 입력하거나,');
            log('warn', 'GDRIVE_AUDIO_FOLDER_ID를 .env에 설정하면 검색 범위를 좁힐 수 있습니다.');
            return null;
        }

        log('ok', `총 ${allFiles.length}개 오디오 파일 발견`);
        allFiles.slice(0, 5).forEach(f => {
            console.log(`  ${C.gray}• ${f.name} (${new Date(f.modifiedTime).toLocaleDateString('ko-KR')})${C.reset}`);
        });

        return allFiles[0]; // 가장 최신 파일 반환
    } catch(e) {
        log('warn', `Drive 검색 실패: ${e.message}`);
        return null;
    }
}

// ══════════════════════════════════════════════════════════
//  Firebase Admin: Firestore 업데이트
// ══════════════════════════════════════════════════════════
async function updateFirestore(dateStr, data) {
    header('Firebase Firestore 업데이트');

    let admin;
    try {
        admin = await import('firebase-admin');
    } catch {
        log('warn', 'firebase-admin이 없습니다. npm install을 실행하세요.');
        log('warn', 'Firestore 업데이트를 건너뜁니다.');
        return false;
    }

    const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || resolve(ROOT, 'serviceAccountKey.json');

    if (!existsSync(SA_PATH)) {
        log('warn', `서비스 계정 키 없음: ${SA_PATH}`);
        log('warn', 'Firebase 콘솔 → 프로젝트 설정 → 서비스 계정에서 키를 다운로드하세요');
        log('warn', 'Firestore 업데이트를 건너뜁니다.');
        return false;
    }

    try {
        const serviceAccount = JSON.parse(readFileSync(SA_PATH, 'utf8'));

        if (!admin.default.apps.length) {
            admin.default.initializeApp({
                credential: admin.default.credential.cert(serviceAccount),
                projectId: 'meditation-1c609',
            });
        }

        const db = admin.default.firestore();
        const ref = db.collection('contents').doc(dateStr);
        const snap = await ref.get();
        const existing = snap.exists ? snap.data() : {};

        const updated = {
            ...existing,
            ...data,
            syncedAt: new Date().toISOString(),
        };

        await ref.set(updated, { merge: true });
        log('ok', `Firestore 업데이트 완료: contents/${dateStr}`);
        return true;
    } catch(e) {
        log('err', `Firestore 업데이트 실패: ${e.message}`);
        return false;
    }
}

// ══════════════════════════════════════════════════════════
//  로컬 JSON 업데이트
// ══════════════════════════════════════════════════════════
function updateLocalJson(dateStr, data) {
    header('로컬 meditation.json 업데이트');

    let json = {
        _schema: 'nmeditation-v2',
        _description: '이한규 365묵상 구조화 데이터 - NotebookLM 자동화 연동',
        lastUpdated: new Date().toISOString(),
        stats: { total: 0, thisMonth: 0, streak: 0 },
        meditations: []
    };

    if (existsSync(JSON_PATH)) {
        try {
            json = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
        } catch(e) {
            log('warn', `기존 JSON 파싱 실패, 새로 생성합니다: ${e.message}`);
        }
    }

    // 기존 항목 업데이트 또는 추가
    const idx = json.meditations.findIndex(m => m.date === dateStr);
    const entry = {
        date: dateStr,
        ...data,
        syncedAt: new Date().toISOString(),
    };

    if (idx >= 0) {
        json.meditations[idx] = { ...json.meditations[idx], ...entry };
        log('ok', `기존 항목 업데이트: ${dateStr}`);
    } else {
        json.meditations.unshift(entry);
        log('ok', `새 항목 추가: ${dateStr}`);
    }

    // 날짜순 정렬 (최신순)
    json.meditations.sort((a,b) => b.date.localeCompare(a.date));
    json.lastUpdated = new Date().toISOString();
    json.stats.total = json.meditations.length;

    const curMonth = dateStr.slice(0, 7);
    json.stats.thisMonth = json.meditations.filter(m => m.date.startsWith(curMonth)).length;

    writeFileSync(JSON_PATH, JSON.stringify(json, null, 2), 'utf8');
    log('ok', `JSON 저장: ${JSON_PATH}`);
    return true;
}

// ══════════════════════════════════════════════════════════
//  메인 동기화 로직
// ══════════════════════════════════════════════════════════
async function syncDate(dateStr) {
    console.log(`\n${C.bold}${C.green}[안티그래비티 묵상 동기화]${C.reset}`);
    console.log(`${C.gray}날짜: ${dateStr} | NotebookLM: ${NOTEBOOK_ID}${C.reset}\n`);

    const result = {
        date: dateStr,
        title: '',
        scriptureRef: '',
        scriptureText: '',
        summary: '',
        keyThemes: [],
        audioUrl: '',
        imageUrl: '',
        notebookLMUrl: NOTEBOOK_URL,
        source: 'notebooklm',
        items: [
            { type: 'notebookLM', title: `이한규365묵상 - ${dateStr}`, url: NOTEBOOK_URL }
        ]
    };

    // Step 1: Google Drive에서 오디오 찾기
    let driveResult = null;
    const authResult = await getGoogleAuth();

    if (authResult) {
        const audioFile = await findNotebookLMAudio(authResult.auth, authResult.google);
        if (audioFile) {
            // Drive 공유 링크 생성
            const audioUrl = `https://drive.google.com/file/d/${audioFile.id}/view?usp=sharing`;
            result.audioUrl = audioUrl;
            result.items.unshift({
                type: 'audio',
                title: audioFile.name.replace(/\.(mp3|wav|m4a|ogg)$/i, ''),
                url: audioUrl
            });
            driveResult = audioFile;
            log('ok', `오디오 파일 연결: ${audioFile.name}`);
        }
    } else {
        log('warn', 'Google Drive 인증 없음 — --auth 플래그로 초기 인증을 실행하세요');
        log('info', `명령어: node scripts/sync.js --auth`);
    }

    // Step 2: 인터랙티브 모드로 메타데이터 입력 받기
    header('묵상 메타데이터 입력');
    log('info', '자동으로 가져올 수 없는 정보는 입력해주세요. (Enter = 건너뜀)');

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(`  ${C.cyan}${q}${C.reset} `, res));

    result.title = (await ask('📖 말씀 제목:')) || result.title;
    result.scriptureRef = (await ask('📍 성경 구절 (예: 요한복음 3:16):')) || '';
    result.scriptureText = (await ask('✍️  성경 본문:')) || '';
    result.summary = (await ask('📝 묵상 요약 (NotebookLM 텍스트 붙여넣기):')) || '';
    const themesInput = await ask('🌿 핵심 테마 (쉼표 구분: 사랑,소망,믿음):');
    result.keyThemes = themesInput ? themesInput.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!result.audioUrl) {
        result.audioUrl = (await ask('🎵 오디오 URL (Google Drive 링크, 없으면 Enter):')) || '';
        if (result.audioUrl) {
            result.items.unshift({ type: 'audio', title: `${result.title || '묵상'} - 오디오`, url: result.audioUrl });
        }
    }

    const imageUrlInput = await ask('🖼️  이미지 URL (Google Drive 링크, 없으면 Enter):');
    result.imageUrl = imageUrlInput || '';
    if (result.imageUrl) {
        result.items.push({ type: 'image', title: `${result.title || '묵상'} - 이미지`, url: result.imageUrl });
    }

    rl.close();

    // Step 3: Firestore 업데이트
    await updateFirestore(dateStr, result);

    // Step 4: 로컬 JSON 업데이트
    updateLocalJson(dateStr, result);

    // 완료 요약
    console.log(`\n${C.bold}${C.green}══ 동기화 완료! ══${C.reset}`);
    console.log(`  날짜: ${C.bold}${dateStr}${C.reset}`);
    if (result.title) console.log(`  제목: ${result.title}`);
    if (result.scriptureRef) console.log(`  말씀: ${result.scriptureRef}`);
    if (result.audioUrl) console.log(`  오디오: ${C.green}연결됨${C.reset}`);
    if (result.keyThemes.length) console.log(`  테마: ${result.keyThemes.join(', ')}`);
    console.log(`\n  🌐 사이트에서 확인: ${C.blue}http://localhost:3000/visual.html?date=${dateStr}${C.reset}`);
    console.log(`  🌐 배포 사이트: ${C.blue}https://meditation-1c609.web.app/visual.html?date=${dateStr}${C.reset}\n`);
}

function printEnvSetupGuide() {
    console.log(`
${C.bold}${C.yellow}[설정 가이드]${C.reset}

1. .env.example을 .env로 복사:
   ${C.cyan}cp .env.example .env${C.reset}

2. Google Cloud Console에서 OAuth2 클라이언트 ID 생성:
   ${C.blue}https://console.cloud.google.com/apis/credentials${C.reset}
   - Google Drive API 활성화
   - OAuth 2.0 클라이언트 ID 생성 (데스크톱 앱)
   - 클라이언트 ID, 시크릿을 .env에 입력

3. Firebase 서비스 계정 키 다운로드:
   ${C.blue}https://console.firebase.google.com/project/meditation-1c609/settings/serviceaccounts/adminsdk${C.reset}
   - 새 비공개 키 생성
   - serviceAccountKey.json으로 저장

4. 최초 인증:
   ${C.cyan}node scripts/sync.js --auth${C.reset}

5. 동기화 실행:
   ${C.cyan}node scripts/sync.js${C.reset}
`);
}

// ══════════════════════════════════════════════════════════
//  엔트리포인트
// ══════════════════════════════════════════════════════════
if (isAuth) {
    header('Google OAuth 초기 인증');
    await authorizeGoogle();
    log('ok', '인증 완료! 이제 node scripts/sync.js 를 실행하세요.');
} else {
    if (!existsSync(resolve(ROOT, '.env'))) {
        log('warn', '.env 파일이 없습니다.');
        printEnvSetupGuide();
    }

    if (isAll) {
        // 전체 동기화 (이번 달)
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth()+1).padStart(2,'0');
        const daysInMonth = new Date(year, today.getMonth()+1, 0).getDate();

        header(`전체 동기화: ${year}-${month}`);
        log('warn', '전체 동기화는 각 날짜별로 입력이 필요합니다. 기존 데이터가 있는 날짜만 업데이트합니다.');

        // 로컬 JSON에서 날짜 목록 가져오기
        if (existsSync(JSON_PATH)) {
            const json = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
            const dates = json.meditations.map(m => m.date);
            log('info', `로컬 JSON에서 ${dates.length}개 날짜 발견`);
            for (const d of dates) {
                await updateFirestore(d, json.meditations.find(m => m.date === d));
            }
            log('ok', '전체 Firestore 동기화 완료');
        }
    } else {
        await syncDate(TARGET_DATE);
    }
}
