import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Upload,
  Eye,
  Check,
  Clock,
  AlertTriangle,
  Map as MapIcon,
  HelpCircle,
  FolderSearch,
  FileCheck2,
  Loader2,
  Hourglass,
} from "lucide-react";
import contributeCardImg from "@/assets/Guides/Map/ContributeMapCardWithHighlightedFileName&Location.png";
import fileExplorerImg from "@/assets/Guides/Map/FileExplorerWindowsWithSearchedMapFile.png";
import selectedFileImg from "@/assets/Guides/Map/SelectedFileAndNameBeforeSubmit.png";
import uploadingImg from "@/assets/Guides/Map/UploadingProgressIndicator.png";
import uploadCompleteImg from "@/assets/Guides/Map/UploadCompleteAndContributionLimit.png";
import pendingAwaitingImg from "@/assets/Guides/Map/PendingContributionWithAwaitingApproval.png";
import contributionExampleImg from "@/assets/Guides/Map/ContributionExample.png";

export function ContributingToTopsMapPostRu() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Общая карта TOPS строится из реальных локальных кэшей карты игроков. Этот гайд показывает,
        как найти правильный <Code>.db</Code>, загрузить его на проверку и понять, что произойдет
        дальше до одобрения и обновления карты.
      </Lede>

      <Section title="Короткая версия" icon={<MapIcon className="size-4" />}>
        <Ol>
          <li>
            Откройте страницу Contribute Map и скопируйте <strong>Server Map ID</strong>.
          </li>
          <li>
            Найдите одноименный файл <Code>.db</Code> в папке карт Vintage Story.
          </li>
          <li>
            Выберите его, при желании укажите имя и нажмите <strong>Upload for Review</strong>.
          </li>
          <li>Дождитесь админской проверки и следующего обновления общей карты.</li>
        </Ol>
        <Callout tone="info">
          <strong>Регистрация не обязательна.</strong> Cairn автоматически выдает contributor key
          при первом посещении страницы.
        </Callout>
      </Section>

      <Section title="Шаг 1: найдите файл карты" icon={<FolderSearch className="size-4" />}>
        <P>
          Страница Contribute Map показывает точный <strong>Server Map ID</strong>, который
          совпадает с именем нужного файла на диске.
        </P>
        <ImageFigure
          src={contributeCardImg}
          alt="Карточка Contribute Map с выделенным Server Map ID."
          caption="Server Map ID вверху страницы - это точное имя нужного файла."
        />
        <P>Если вы раньше не открывали папку с картами, используйте системный путь для вашей ОС:</P>
        <OSBlock heading="Windows">
          <Pre>%appdata%\VintagestoryData\Maps</Pre>
        </OSBlock>
        <OSBlock heading="macOS">
          <Pre>~/Library/Application Support/VintagestoryData/Maps</Pre>
        </OSBlock>
        <OSBlock heading="Linux">
          <Pre>~/.config/VintagestoryData/Maps</Pre>
        </OSBlock>
        <P>
          Проще всего вставить Server Map ID в поиск файлового менеджера, чтобы остался только
          нужный <Code>.db</Code>.
        </P>
        <ImageFigure
          src={fileExplorerImg}
          alt="Папка Maps, отфильтрованная по Server Map ID."
          caption="Поиск по Server Map ID быстро находит нужный файл даже в большой папке Maps."
        />
        <Callout tone="warning">
          Загружайте именно кэш карты <Code>.db</Code>, а не save-файл мира.
        </Callout>
      </Section>

      <Section title="Шаг 2: выберите файл и отправьте" icon={<FileCheck2 className="size-4" />}>
        <P>
          После выбора файла форма показывает его размер. Поле <strong>Your Name</strong> можно
          оставить пустым, заполнить любым именем или подставить имя аккаунта.
        </P>
        <ImageFigure
          src={selectedFileImg}
          alt="Форма Contribute Map с выбранным файлом и активной кнопкой отправки."
          caption="Когда файл выбран, Upload for Review становится доступной."
        />
      </Section>

      <Section title="Шаг 3: пока идет загрузка" icon={<Loader2 className="size-4" />}>
        <P>
          Нажмите <strong>Upload for Review</strong> и дождитесь завершения. Кэши карты бывают очень
          большими, поэтому прогресс-бар может двигаться заметно медленно.
        </P>
        <ImageFigure
          src={uploadingImg}
          alt="Кнопка Upload for Review и прогресс-бар."
          caption="Полоса прогресса показывает, насколько далеко продвинулась загрузка."
        />
        <Callout tone="warning">
          Старайтесь не менять сеть и не заставлять игру активно переписывать тот же{" "}
          <Code>.db</Code> во время отправки.
        </Callout>
      </Section>

      <Section title="Загрузка завершена" icon={<Check className="size-4" />}>
        <P>
          После успеха вы увидите подтверждение и напоминание об ограничениях: одна pending-загрузка
          одновременно и интервал после одобренного вклада.
        </P>
        <ImageFigure
          src={uploadCompleteImg}
          alt="Успешная загрузка и баннер с ограничениями."
          caption="После успешной отправки форма блокируется, пока текущий вклад не будет обработан."
        />
      </Section>

      <Section title="Ожидание проверки" icon={<Hourglass className="size-4" />}>
        <P>
          В pending-списке рядом с вкладом могут временно показываться{" "}
          <em>Awaiting admin compute</em> для match score и preview. Это нормально: тяжелые
          вычисления часто запускаются пакетами.
        </P>
        <ImageFigure
          src={pendingAwaitingImg}
          alt="Pending-вклад со статусом Awaiting admin compute."
          caption="Пока идет ожидание, вклад уже существует, но превью и оценка совпадения могут быть отложены."
        />
      </Section>

      <Section title="Что видит админ" icon={<Eye className="size-4" />}>
        <P>
          После вычислений админ видит chip совпадения с существующей картой и превью, где зеленым
          выделены новые чанки из вашего файла.
        </P>
        <div className="flex flex-wrap gap-1.5 my-1">
          <Badge className="bg-emerald-600 hover:bg-emerald-600">Looks like our map</Badge>
          <Badge variant="secondary">Partial match</Badge>
          <Badge variant="destructive">May be wrong file</Badge>
        </div>
        <ImageFigure
          src={contributionExampleImg}
          alt="Проверенный вклад с chip совпадения и превью."
          caption="Так выглядит вклад после проверки: оценка совпадения, overlap, similarity и наглядное превью новых областей."
        />
      </Section>

      <Section title="Когда карта обновится" icon={<Clock className="size-4" />}>
        <P>
          Одобрение не означает мгновенное обновление публичной карты. Итоговое изображение карты
          обычно пересобирается админом примерно раз в неделю.
        </P>
      </Section>

      <Section title="Почему вклад могут отклонить" icon={<AlertTriangle className="size-4" />}>
        <Ul>
          <li>
            <strong>Неверный файл.</strong> Это не кэш карты Vintage Story или кэш с другого
            сервера.
          </li>
          <li>
            <strong>Нечего добавлять.</strong> Все чанки из файла уже есть на общей карте.
          </li>
          <li>
            <strong>Файл не от этого сервера.</strong> Chip <em>May be wrong file</em> обычно
            указывает именно на это.
          </li>
        </Ul>
        <P>
          По умолчанию вклад только закрывает пробелы и не перезаписывает уже существующие чанки.
        </P>
      </Section>

      <Section title="После одобрения" icon={<HelpCircle className="size-4" />}>
        <P>
          Одобренные вклады некоторое время показываются в публичной истории Recent Contributions.
          Если позже обнаружится ошибка, админ может откатить отдельный вклад.
        </P>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-4">
          <div className="text-sm">
            <p className="font-medium text-foreground">Готовы загрузить кэш карты?</p>
            <p className="text-muted-foreground">
              Перейдите на страницу Contribute Map и возьмите ваш Server Map ID.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute">
            <Button>
              <Upload className="size-4 mr-1.5" />
              Открыть Contribute Map
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="text-base text-foreground/90 leading-relaxed border-l-2 border-primary/40 pl-3">
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
function Ol({ children }: { children: ReactNode }) {
  return <ol className="list-decimal list-outside space-y-1.5 pl-5">{children}</ol>;
}
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-foreground">
      {children}
    </code>
  );
}
function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="my-1.5 overflow-x-auto rounded border bg-muted/40 p-2 text-xs font-mono text-foreground whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}
function OSBlock({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="rounded border bg-card p-3 space-y-2">
      <p className="text-sm font-medium text-foreground">{heading}</p>
      <div className="text-xs text-muted-foreground space-y-2">{children}</div>
    </div>
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
