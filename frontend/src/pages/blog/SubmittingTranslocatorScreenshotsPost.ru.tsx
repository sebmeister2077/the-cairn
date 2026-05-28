import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  Camera,
  Clock,
  Eye,
  FileImage,
  HelpCircle,
  MapPinned,
  Send,
  Upload,
} from "lucide-react";
import highlightedScreenshotImg from "@/assets/TLContributeExample_Highlighted.png";
import submitForReviewImg from "@/assets/ContributeTLSubmitForReview.png";
import submissionsSectionImg from "@/assets/TLContributeSubmissionSection.png";

export function SubmittingTranslocatorScreenshotsPostRu() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Поток со скриншотами нужен, когда вы хотите добавить одну полную связь транслокатора без
        экспорта путевых точек. Вы загружаете два PNG - по одному на каждый конец - а Cairn читает
        координаты из HUD и проверяет миникарту.
      </Lede>
      <Section title="Что нужно заранее" icon={<FileImage className="size-4" />}>
        <Ul>
          <li>Сделайте один обычный скриншот у первого конца починенного транслокатора.</li>
          <li>Сделайте второй скриншот у второго конца.</li>
          <li>Оставьте оба файла в PNG.</li>
          <li>Войдите в аккаунт Cairn, чтобы заявку можно было отзывать и нормально проверять.</li>
        </Ul>
      </Section>
      <Section title="Сделайте полезный скриншот" icon={<Camera className="size-4" />}>
        <P>
          Не обрезайте изображение до одной миникарты или одного транслокатора. Для проверки нужны
          HUD, координаты и окружающий контекст.
        </P>
        <ImageFigure
          src={highlightedScreenshotImg}
          alt="Пример правильного скриншота TL с подсвеченными ключевыми областями."
          caption="Хороший скриншот показывает починенный TL, миникарту и читаемые координаты в одном кадре."
        />
      </Section>
      <Section title="Что должно быть видно" icon={<Eye className="size-4" />}>
        <Checklist>
          <li>
            <strong>Координаты:</strong> X и Z должны читаться.
          </li>
          <li>
            <strong>Миникарта:</strong> она нужна worker-у для сравнения с серверной картой.
          </li>
          <li>
            <strong>Достаточно местности:</strong> чем больше видимого рельефа, тем надежнее
            сравнение.
          </li>
          <li>
            <strong>Сам транслокатор:</strong> должно быть видно, что снимок сделан именно у
            endpoint-а TL.
          </li>
        </Checklist>
      </Section>
      <Section title="Частые ошибки" icon={<AlertTriangle className="size-4" />}>
        <StatusGrid>
          <MiniCard
            heading="Координаты скрыты"
            badge={<Badge variant="destructive">исправить</Badge>}
          >
            Если числа закрыты чатом или другим UI, OCR может ошибиться.
          </MiniCard>
          <MiniCard heading="Нет миникарты" badge={<Badge variant="destructive">исправить</Badge>}>
            Без миникарты сравнение с серверной картой не запустится.
          </MiniCard>
          <MiniCard
            heading="Загружен один конец"
            badge={<Badge variant="destructive">исправить</Badge>}
          >
            Для связи TL обязательно нужны оба endpoint-а.
          </MiniCard>
          <MiniCard heading="Не тот сервер" badge={<Badge variant="secondary">warning</Badge>}>
            Если миникарта плохо совпадает с картой сервера, заявка получит предупреждение.
          </MiniCard>
        </StatusGrid>
      </Section>
      <Section title="Отправьте пару" icon={<Upload className="size-4" />}>
        <P>
          На странице Contribute TLs положите первый скриншот в <strong>Screenshot A</strong>,
          второй - в <strong>Screenshot B</strong>, при желании добавьте короткую подпись и нажмите{" "}
          <strong>Submit for review</strong>.
        </P>
        <ImageFigure
          src={submitForReviewImg}
          alt="Карточка загрузки пары TL по скриншотам."
          caption="Нужны ровно два PNG: один на endpoint A и один на endpoint B."
        />
      </Section>
      <Section title="Что делает анализ" icon={<MapPinned className="size-4" />}>
        <P>
          Сначала OCR читает координаты, затем миникарта сравнивается с crop-ом серверной карты
          вокруг найденных X/Z. Это помогает админу понять, что кадр действительно относится к
          нужному месту.
        </P>
      </Section>
      <Section title="Как читать свои отправки" icon={<Clock className="size-4" />}>
        <P>
          Раздел <strong>Your screenshot submissions</strong> показывает статус заявки, ход анализа,
          найденные координаты, предупреждения и время отправки. Пока заявка pending, ее можно
          отозвать.
        </P>
        <ImageFigure
          src={submissionsSectionImg}
          alt="Список отправленных скриншотных заявок."
          caption="Через список видно, идет ли анализ, какие координаты были найдены и есть ли предупреждения."
        />
      </Section>
      <Section title="Когда стоит переснять" icon={<HelpCircle className="size-4" />}>
        <P>
          Переснимайте, если координаты не читаются, миникарта перекрыта, вы дважды загрузили один и
          тот же конец или warning явно указывает на неправильный матч.
        </P>
      </Section>
      <Separator />
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Готовы отправить пару скриншотов?</p>
            <p className="text-muted-foreground">
              Сделайте по одному полному HUD-скриншоту у каждого конца TL и откройте Contribute TLs.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute-tls">
            <Button>
              <Send className="mr-1.5 size-4" />
              Открыть Contribute TLs
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-primary/40 pl-3 text-base leading-relaxed text-foreground/90">
      {children}
    </p>
  );
}
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        {icon ? <span className="text-primary">{icon}</span> : null}
        {title}
      </h2>
      <div className="space-y-3 text-muted-foreground">{children}</div>
    </section>
  );
}
function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}
function Ul({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-1.5 pl-5">{children}</ul>;
}
function Checklist({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-2 pl-5">{children}</ul>;
}
function ImageFigure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="space-y-2">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded border bg-muted/40"
      >
        <img src={src} alt={alt} loading="lazy" className="h-auto w-full" />
      </a>
      <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
function StatusGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}
function MiniCard({
  heading,
  badge,
  children,
}: {
  heading: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{heading}</p>
        {badge}
      </div>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
