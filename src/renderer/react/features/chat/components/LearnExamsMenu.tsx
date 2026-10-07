import { Popover } from "antd";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import type { LearnExamView } from "../../../../../shared/learn-exam";
import { useTranslation } from "../../../i18n";
import { learnExamApi } from "../pages/chat-page-bridge";
import "./LearnExamsMenu.css";

export function LearnExamsMenu({ conversationId, onOpened }: { conversationId: string; onOpened: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [exams, setExams] = useState<LearnExamView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const api = learnExamApi();
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      setLoading(true); setError(false);
      try {
        if (!api) throw new Error("Exam bridge unavailable");
        const next = await api.listByConversation(conversationId);
        if (!disposed && current === revision) setExams(next.sort((a, b) => b.createdAt - a.createdAt));
      } catch {
        if (!disposed && current === revision) setError(true);
      } finally {
        if (!disposed && current === revision) setLoading(false);
      }
    };
    const changed = (event: { conversationId: string }) => { if (event.conversationId === conversationId) void refresh(); };
    const offCreated = api?.onCreated(changed);
    const offChanged = api?.onChanged(changed);
    void refresh();
    return () => { disposed = true; offCreated?.(); offChanged?.(); };
  }, [open, conversationId]);

  async function openExam(exam: LearnExamView) {
    setOpening(exam.examId); setError(false);
    try {
      if (!await window.browserPanel?.openExam(exam.examId, conversationId)) throw new Error("Exam could not open");
      onOpened(); setOpen(false);
    } catch { setError(true); }
    finally { setOpening(null); }
  }

  return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight" content={
    <div className="cy-learn-exams-menu">
      <strong>{t("learnExams.title")}</strong>
      {loading && <p role="status">{t("learnExams.loading")}</p>}
      {error && <p role="alert">{t("learnExams.error")}</p>}
      {!loading && !error && !exams.length && <p>{t("learnExams.empty")}</p>}
      <div className="cy-learn-exams-menu__list">
        {exams.map(exam => <button type="button" key={exam.examId} disabled={opening !== null} onClick={() => void openExam(exam)}>
          <span>{exam.title}</span>
          <small>{t(`learnExams.status.${exam.status}`)} · {t("learnExams.questions", { count: exam.questions.length })}
            {exam.gradingResult && ` · ${exam.gradingResult.totalScore}/${exam.totalPoints}`}</small>
        </button>)}
      </div>
    </div>
  }>
    <button type="button" className="cy-inspector-browser-toggle" title={t("learnExams.title")} aria-label={t("learnExams.title")}>
      <FileText size={17} strokeWidth={1.8} />
    </button>
  </Popover>;
}
