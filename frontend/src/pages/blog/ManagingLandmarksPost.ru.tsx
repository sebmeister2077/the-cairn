import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  ChevronsUpDown,
  Clock,
  MapPin,
  Plus,
  Search,
  Send,
  UserPlus,
} from "lucide-react";
import createAccountImg from "@/assets/Guides/Landmarks/ContributeWaypointsCreateAccountExample.png";
import summaryCardImg from "@/assets/Guides/Landmarks/ContributeLandmarksSummaryCardExample.png";
import expandedCardImg from "@/assets/Guides/Landmarks/ContributeLandmarksExpandedCard.png";
import addPopupImg from "@/assets/Guides/Landmarks/ContributeLandmarksAddPopupExample.png";
import searchSuggestRenameImg from "@/assets/Guides/Landmarks/ContributeLandmarksSearchSuggestRenameExample.png";
import renamePendingImg from "@/assets/Guides/Landmarks/ContributeLandmarksRenamePendingExample.png";

export function ManagingLandmarksPostRu() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Ориентиры - это именованные точки на общей карте TOPS. С аккаунтом Cairn можно добавлять
        новые метки, сразу переименовывать свои и отправлять предложения по переименованию чужих.
      </Lede>
      <Section title="Сначала нужен аккаунт" icon={<UserPlus className="size-4" />}>
        <P>
          Без входа панель ориентиров показывает CTA вместо карточки управления. Искать ориентиры и
          включать их отображение можно и без аккаунта, но добавление и переименование требуют
          входа.
        </P>
        <ImageFigure
          src={createAccountImg}
          alt="Панель TOPS Map с CTA на создание аккаунта."
          caption="Если вы не вошли в систему, панель предлагает сначала создать аккаунт."
        />
      </Section>
      <Section title="Карточка ориентиров после входа" icon={<MapPin className="size-4" />}>
        <P>
          После входа появляется карточка <strong>Landmarks added by me</strong> со счетчиком ваших
          ориентиров и кнопкой <strong>+ Add</strong>.
        </P>
        <ImageFigure
          src={summaryCardImg}
          alt="Свернутая карточка ориентиров с кнопкой Add."
          caption="Разворачивайте карточку, чтобы посмотреть свои метки, или сразу нажимайте + Add."
        />
      </Section>
      <Section title="Добавьте ориентир" icon={<Plus className="size-4" />}>
        <P>
          Укажите короткое понятное имя и абсолютные координаты точки. X и Z обязательны и должны
          быть целыми, Y нужен только если высота действительно важна.
        </P>
        <ImageFigure
          src={addPopupImg}
          alt="Окно Add a landmark с полями label и координат."
          caption="Label обязателен; X и Z обязательны; Y необязателен."
        />
        <Checklist>
          <li>
            <strong>Label:</strong> короткое читаемое имя, например <Code>Server spawn</Code> или{" "}
            <Code>NE outpost</Code>.
          </li>
          <li>
            <strong>X и Z:</strong> те же абсолютные координаты, что показывает{" "}
            <Code>/whereami</Code>.
          </li>
          <li>
            <strong>Y:</strong> добавляйте только если высота реально помогает понять место.
          </li>
        </Checklist>
        <Callout tone="warning">
          Ориентиры глобальные: после добавления они становятся видны всем пользователям TOPS map.
        </Callout>
      </Section>
      <Section title="Управляйте своими ориентирами" icon={<ChevronsUpDown className="size-4" />}>
        <P>
          Развернутая карточка показывает все ваши ориентиры, их координаты, тип и кнопку
          переименования.
        </P>
        <ImageFigure
          src={expandedCardImg}
          alt="Развернутая карточка Landmarks added by me."
          caption="Переименования ориентиров, которые добавили вы сами, применяются сразу."
        />
        <StatusGrid>
          <MiniCard heading="Переименовать свой" badge={<Badge variant="secondary">live</Badge>}>
            Нажмите на карандаш - новое имя сразу записывается в общий список ориентиров.
          </MiniCard>
          <MiniCard
            heading="Удалить ориентир"
            badge={<Badge variant="outline">через админа</Badge>}
          >
            Удаление пока не вынесено в пользовательский интерфейс, поэтому для него нужен админ.
          </MiniCard>
        </StatusGrid>
      </Section>
      <Section title="Предложите новое имя для чужой метки" icon={<Search className="size-4" />}>
        <P>
          Поле <strong>Suggest a rename for any landmark</strong> позволяет найти любую метку на
          карте и отправить более подходящее имя на проверку.
        </P>
        <ImageFigure
          src={searchSuggestRenameImg}
          alt="Поиск ориентиров для предложения нового имени."
          caption="Поиск показывает совпадающие метки с координатами и типом, после чего можно открыть диалог предложения нового имени."
        />
      </Section>
      <Section title="Следите за pending-заявками" icon={<Clock className="size-4" />}>
        <P>
          После отправки предложения в карточке появляется раздел{" "}
          <strong>Pending rename requests</strong> со старым именем, новым именем, временем отправки
          и текущим статусом.
        </P>
        <ImageFigure
          src={renamePendingImg}
          alt="Строка pending-заявки на переименование."
          caption="Заявка остается в списке до одобрения или отклонения админом."
        />
        <StatusGrid>
          <MiniCard heading="Pending" badge={<Badge variant="secondary">ожидание</Badge>}>
            Предложение еще не просмотрено, на карте пока остается старое имя.
          </MiniCard>
          <MiniCard
            heading="Approved"
            badge={<Badge className="bg-emerald-600 hover:bg-emerald-600">live</Badge>}
          >
            Новое имя принято и уже видно всем пользователям карты.
          </MiniCard>
          <MiniCard heading="Rejected" badge={<Badge variant="destructive">closed</Badge>}>
            Предложение отклонено, например из-за дубликата, тестовой записи или плохого описания
            места.
          </MiniCard>
        </StatusGrid>
      </Section>
      <Section title="Хорошие привычки" icon={<AlertTriangle className="size-4" />}>
        <Checklist>
          <li>
            <strong>Одна метка на одно место.</strong> Не дублируйте ориентиры вокруг одной базы.
          </li>
          <li>
            <strong>Название должно описывать место.</strong> Предпочитайте понятные слова локальным
            шуткам.
          </li>
          <li>
            <strong>Выбирайте правильный тип.</strong> Base, Server, Terminus и Misc нужны для
            удобной фильтрации.
          </li>
          <li>
            <strong>Проверяйте координаты.</strong> Ошибочные ориентиры приходится убирать админам.
          </li>
        </Checklist>
      </Section>
      <Separator />
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Готовы добавить ориентир?</p>
            <p className="text-muted-foreground">
              Откройте TOPS Map и найдите карточку ориентиров в боковой панели.
            </p>
          </div>
          <NavLink to="/multiplayer/tops-map">
            <Button>
              <Send className="mr-1.5 size-4" />
              Открыть TOPS Map
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
function Checklist({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-2 pl-5">{children}</ul>;
}
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}
function Callout({ tone, children }: { tone: "info" | "warning"; children: ReactNode }) {
  const cls =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-sky-300 bg-sky-50 text-sky-900";
  return <div className={`rounded border ${cls} p-3 text-xs`}>{children}</div>;
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
