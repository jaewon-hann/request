import express from "express";
import cors from "cors";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());                       // Figma 플러그인 iframe에서 fetch 허용
app.use(express.json({ limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });

// AI 키가 없어도 서버는 켜진다 (프레임 저장/불러오기 테스트용). /api/generate만 키 필요.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── 생성 결과 저장소 (데모용 인메모리. 운영은 Supabase/Redis 등 권장) ──
const store = new Map();

// ── 레이아웃 JSON 스키마: 서버와 플러그인 사이의 "계약" ──
// 이 스키마가 곧 Figma Plugin API 매핑표가 됩니다.
const SCHEMA_INSTRUCTION = `
너는 B2B 제안서 레이아웃 디자이너다. 아래 정보를 바탕으로 제안서 레이아웃을
JSON으로만 출력한다. 마크다운, 설명, 코드펜스 없이 순수 JSON 객체만 출력한다.

스키마:
{
  "title": string,                       // 제안서 제목
  "pages": [
    {
      "name": string,                    // 프레임 이름 (예: "표지", "문제 정의")
      "width": number,                   // 기본 1920
      "height": number,                  // 기본 1080
      "background": string,              // hex, 예 "#0A2540"
      "elements": [
        {
          "type": "text",
          "content": string,
          "x": number, "y": number,
          "width": number,               // 텍스트 박스 너비
          "fontSize": number,
          "fontWeight": "Regular" | "Medium" | "Bold",
          "color": string,               // hex
          "align": "LEFT" | "CENTER" | "RIGHT"
        },
        {
          "type": "rect",
          "x": number, "y": number,
          "width": number, "height": number,
          "fill": string,                // hex
          "cornerRadius": number
        }
      ]
    }
  ]
}

규칙:
- 좌표 단위는 px, 원점은 프레임 좌상단(0,0).
- 요소가 프레임 밖으로 나가지 않게 한다.
- 표지 → 문제/현황 → 데이터 근거 → 제안 내용 → 목표 추정치 → CTA/문의 순서를 기본으로 하되,
  입력 내용에 맞게 조정한다.
- 레퍼런스 이미지가 주어지면 그 컬러/타이포/구성 톤을 최대한 따른다.
- 숫자 데이터(목표 추정치 등)는 큰 폰트로 강조한다.
`;

function buildUserContent({ recipient, proposalBody, target, extra, refImages }) {
  const parts = [];
  if (refImages?.length) {
    parts.push({ type: "text", text: "아래는 레퍼런스 제안서 이미지다. 이 스타일을 따라라." });
    for (const img of refImages) {
      parts.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
  }
  parts.push({
    type: "text",
    text: [
      `제안 보낼 곳: ${recipient || "(미지정)"}`,
      `제안 내용: ${proposalBody || "(미지정)"}`,
      `목표 추정치: ${target || "(미지정)"}`,
      extra ? `추가 정보: ${extra}` : "",
      "",
      "위 정보로 제안서 레이아웃 JSON을 출력하라.",
    ].join("\n"),
  });
  return parts;
}

// ── 생성 엔드포인트: 폼 입력 + 레퍼런스 이미지 → 레이아웃 JSON ──
app.post("/api/generate", upload.array("references", 5), async (req, res) => {
  try {
    if (!anthropic) return res.status(400).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다 (프레임 저장/불러오기는 키 없이 됩니다)" });
    const { recipient, proposalBody, target, extra } = req.body;

    const refImages = (req.files || []).map((f) => ({
      mediaType: f.mimetype,
      data: f.buffer.toString("base64"),
    }));

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SCHEMA_INSTRUCTION,
      messages: [
        { role: "user", content: buildUserContent({ recipient, proposalBody, target, extra, refImages }) },
      ],
    });

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    let layout;
    try {
      layout = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "레이아웃 JSON 파싱 실패", raw });
    }

    const id = randomUUID().slice(0, 8);
    store.set(id, { layout, createdAt: Date.now() });

    res.json({ id, layout });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── 플러그인이 ID로 레이아웃을 가져가는 엔드포인트 ──
app.get("/api/layout/:id", (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "해당 ID의 레이아웃이 없습니다" });
  res.json(rec.layout);
});

// ── 고정 섹션 프레임 저장소 (마스터 → 서버 → 사용자 파일) ──
const frameStore = new Map();

// 마스터에서 직렬화한 프레임 저장 (이름 = ID로 사용, 없으면 랜덤)
app.post("/api/frames", (req, res) => {
  const { name, frames } = req.body;
  if (!frames) return res.status(400).json({ error: "frames가 없습니다" });
  const id = (name || randomUUID().slice(0, 8)).replace(/\s+/g, "-");
  frameStore.set(id, { frames, savedAt: Date.now() });
  res.json({ id });
});

// 사용자 파일에서 ID로 프레임 가져가기
app.get("/api/frames/:id", (req, res) => {
  const rec = frameStore.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "해당 ID의 섹션이 없습니다" });
  res.json({ frames: rec.frames });
});

// 저장된 고정 섹션 목록 (웹 폼에서 체크리스트로 쓸 수 있음)
app.get("/api/frames", (req, res) => {
  res.json({ sections: [...frameStore.keys()] });
});

const PORT = process.env.PORT || 3000;
app.get("/health", (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
