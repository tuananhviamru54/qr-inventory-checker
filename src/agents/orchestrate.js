// Quy trình chốt báo cáo: chuyên gia phân tích → kế toán trưởng kiểm tra độ chính xác → (sai thì chuyên gia làm lại).
import { analyzeReport } from './expert.js';
import { reviewDraft } from './reviewer.js';

const plain = (h) => h.replace(/<[^>]+>/g, '');

export async function analyzeAndReview(config, { draftHtml, facts, focus, onStage = () => {} }) {
  const maxRounds = config.bot?.maxReviewRounds ?? 2;
  const factsForReview = { ...facts, dong_lien_quan: focus };
  let feedback, expert, review;
  for (let round = 1; ; round++) {
    await onStage('expert');
    expert = await analyzeReport(config.ai, { facts, focus, feedback });
    await onStage('review');
    review = await reviewDraft(config.ai, { draft: plain([draftHtml, expert.html].filter(Boolean).join('\n\n')), facts: factsForReview });
    if (review.status !== 'khong_dat' || expert.status !== 'ok' || round >= maxRounds) break;
    feedback = review.sai_sot;
  }
  return { expert, review };
}
