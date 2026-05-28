import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LAST_UPDATED = "25 мая 2026";
const CONTACT_EMAIL = "vswaypoint.jokingly672@passinbox.com";

export function PrivacyPageRu() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Политика конфиденциальности</CardTitle>
        <p className="text-xs text-muted-foreground">Последнее обновление: {LAST_UPDATED}</p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Черновое уведомление.</strong> Эта политика является добросовестным описанием
          того, как сервис обращается с данными, и написана оператором. Это не юридическая
          консультация. Если у вас есть вопросы, напишите нам на{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">1. Кто мы</h2>
          <p>
            Cairn («Сервис») — это неофициальный фанатский веб-инструментарий для игры{" "}
            <em>Vintage Story</em>. Он ведется как хобби-проект. По вопросам конфиденциальности
            пишите на{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <p>Сервис не связан с Anego Studios, разработчиком Vintage Story, и не одобрен ими.</p>
          <p>
            Сервис был создан на основе анализа байтовой структуры файлов сохранений и кэша карты,
            которые <em>Vintage Story</em> записывает на диск на компьютере самого пользователя, а
            также общедоступной документации сообщества.{" "}
            <strong>Декомпилированный игровой код не использовался</strong>, и сервис не содержит
            игровых ассетов.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            2. Данные, хранящиеся в браузере
          </h2>
          <p>
            Мы используем <strong>local storage</strong> браузера, чтобы сервис работал корректно.
            Мы <strong>не</strong> используем сторонние tracking cookies, рекламные cookies или
            сторонние аналитические сервисы (без Google Analytics, Plausible, пикселей и т.п.).
            Однако у нас есть first-party usage log на собственном backend — см. раздел 4c.
            Конкретный состав данных в браузере со временем может меняться по мере добавления,
            изменения или удаления функций. Примеры того, что может храниться:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Ваш <strong>API key</strong>, который одновременно аутентифицирует запросы и
              идентифицирует ваш аккаунт.
            </li>
            <li>
              Ваше состояние разрешений (например, admin, contributor), чтобы интерфейс мог показать
              доступные вам инструменты без дополнительного запроса к серверу.
            </li>
            <li>Факт принятия этого уведомления, чтобы не показывать его при каждом посещении.</li>
            <li>
              Предпочтения и кэшированные данные для удобства, например недавно загруженную
              информацию о карте или последнее состояние просмотренной карты.
            </li>
          </ul>
          <p>
            Вы можете очистить эти данные в любой момент через настройки сайта в браузере. Это
            приведет к выходу из аккаунта и сбросу предпочтений.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            3. Данные, которые вы загружаете
          </h2>
          <p>
            Некоторые инструменты принимают файлы. Мы обращаемся с ними двумя разными способами:
          </p>
          <h3 className="font-medium text-foreground">
            3.1 Файлы, которые обрабатываются и удаляются
          </h3>
          <p>
            Файлы сохранений (<code className="rounded bg-muted px-1 text-xs">.vcdbs</code>), списки
            путевых точек и локальные файлы кэша карты (
            <code className="rounded bg-muted px-1 text-xs">.db</code>), загружаемые в инструменты
            Extract, Import, Delete, Commands и Local Map Viewer, обрабатываются в памяти или во
            временном хранилище и <strong>удаляются сразу</strong> после возврата ответа. Мы не
            сохраняем их копии.
          </p>
          <h3 className="font-medium text-foreground">
            3.2 Файлы, передаваемые в общую карту сообщества
          </h3>
          <p>
            Файлы, которые вы отправляете через инструмент <strong>Contribute</strong>, хранятся в
            Cloudflare R2 и проверяются администратором. Одобренные вклады
            <strong> необратимо объединяются</strong> с общим датасетом карты сообщества. После
            слияния данные невозможно идентифицировать или удалить по отдельности, поскольку они
            смешиваются с вкладами других пользователей. Отклоненные pending-вклады удаляются.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            4. Данные, которые мы собираем автоматически
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>IP-адрес</strong> — используется в памяти нашим rate limiter для защиты от
              злоупотреблений. Мы <strong>не</strong> сохраняем raw IP. Мы сохраняем только
              односторонний <strong>HMAC-SHA256 hash</strong> этого IP (с секретной солью), чтобы:
              обнаруживать аккаунты, использующие одно и то же соединение; и применять IP-level bans
              к аккаунтам, нарушающим правила. Этот hash необратим и не позволяет восстановить
              исходный IP.
            </li>
            <li>
              <strong>Стандартные request logs</strong> — backend-хост (Render) записывает
              метаданные запросов: метод, путь, статус, IP, user-agent и timestamp. Они хранятся
              согласно стандартной политике хранения логов хоста.
            </li>
            <li>
              <strong>API key</strong> — отправляется с каждым запросом в заголовке
              <code className="rounded bg-muted px-1 text-xs">X-API-Key</code>, чтобы мы могли вас
              аутентифицировать.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4a. Профиль аккаунта</h2>
          <p>Когда вы впервые используете API key, мы создаем для вас аккаунт. Аккаунт хранит:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Автоматически сгенерированное <strong>display name</strong> (например,
              <em> Bright-Explorer-1234</em>). Вы не выбираете его сами; мы генерируем его и можем
              выдать новое случайное имя по запросу. Оно публично показывается рядом с вашими
              вкладами.
            </li>
            <li>
              Необязательное <strong>in-game name</strong>, которое вы можете задать сами для
              участия в opt-in leaderboards и идентификации для других игроков.
            </li>
            <li>
              Управляемые вами opt-in flags: отображение в публичном списке{" "}
              <strong>hireable</strong>, на публичном <strong>leaderboard</strong> и публикация
              вашей статистики вкладов.
            </li>
            <li>Версию Terms, которую вы приняли, момент принятия и время создания аккаунта.</li>
            <li>Флаг, указывающий, был ли ваш аккаунт первым, созданным на данном IP hash.</li>
          </ul>
          <p>
            Мы <strong>не</strong> запрашиваем и не храним email, пароль, настоящее имя или другие
            идентификаторы кроме перечисленных выше.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4b. Записи модерации</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>User flags</strong> — система автоматически записывает review flags, например
              «another account exists on this IP hash» или «your in-game name collides with another
              user's». Админы могут пометить такие флаги как valid, abusive или dismissed. Сами по
              себе флаги не блокируют доступ.
            </li>
            <li>
              <strong>IP-hash bans</strong> — если соединение забанено за злоупотребления, бан
              сохраняется по IP hash (а не по raw IP) вместе с reason code, заметками админа и
              сроком действия.
            </li>
            <li>
              <strong>Admin audit log</strong> — append-only log действий модерации (bans, account
              deletions, name regenerations, re-keys, flag resolutions) для подотчетности.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4c. Внутренний usage log</h2>
          <p>
            Чтобы понимать, как используется сервис, замечать паттерны злоупотреблений и планировать
            емкость, backend записывает небольшое <strong>usage event</strong> каждый раз, когда
            происходят определенные действия (например: отправка вклада, approval/rejection вклада,
            redemption backup download link, moderation action). Каждое событие хранит:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Тип и категорию события (например, <em>contribution.submitted</em>).
            </li>
            <li>Timestamp (UTC).</li>
            <li>
              Непрозрачный идентификатор API key, который выполнил действие (тот же идентификатор,
              что уже связан с профилем аккаунта, но никогда не raw key).
            </li>
            <li>
              Небольшой JSON metadata blob с неидентифицирующим контекстом, например contribution
              id, landmark id или число tile-ов.
            </li>
            <li>
              Для redemption backup links — тот же <strong>IP hash</strong>, описанный в разделе 4
              (никогда не raw IP).
            </li>
          </ul>
          <p>
            Этот лог виден только администраторам через внутреннюю панель и
            <strong> никогда не передается третьим лицам</strong>. Он хранится бессрочно, чтобы
            можно было сравнивать активность во времени. Если вы удалите аккаунт, прошлые события
            останутся в логе, но перестанут быть связаны с реальным display name и будут привязаны
            только к тому же opaque tombstone, описанному в разделе 8.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            4d. Отправки «Save this route for road workers»
          </h2>
          <p>
            У route planner есть необязательная кнопка{" "}
            <strong>«Save this route for road workers»</strong>. Данные отправляются только когда вы
            сами нажимаете ее. Каждая отправка сохраняет:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Сам маршрут: стартовые и конечные координаты, необязательные подписи endpoints,
              цепочку hops через translocator, walk distance, travel time и параметры cost model.
            </li>
            <li>
              Непрозрачный идентификатор вашего API key, если вы вошли в систему,{" "}
              <strong>или</strong>
              тот же односторонний <strong>HMAC-SHA256 hash</strong> IP из раздела 4, если вы
              анонимны. Они используются только для 24-hour soft deduplication и rate limiting.
            </li>
            <li>Timestamp (UTC).</li>
          </ul>
          <p>
            Цель — помочь maintainer-ам карты расставлять приоритеты для туннелей, signage и
            shortcuts. Aggregated и anonymised totals (popular routes, popular translocator
            connections, endpoint heatmap) публикуются на всегда-публичной странице
            <code className="rounded bg-muted px-1 text-xs">/public/road-workers</code>; эта
            публичная страница <strong>не</strong> раскрывает API key ids или IP hashes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">5. Серверные записи</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Object storage</strong> — база данных общей карты сообщества, файлы pending
              contributions, rendered preview PNGs, cached map chunks, а также данные путевых точек.
            </li>
            <li>
              <strong>Application database</strong> — метаданные вкладов (id, status, timestamps,
              source filename, file size, contributor reference); audit log одобренных merges; поля{" "}
              <strong>account profile</strong> из раздела 4a; <strong>moderation records</strong>
              из раздела 4b; а также ваш API key, привязанный к hashed IP, с которого он был впервые
              использован.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            6. Третьи лица (sub-processors)
          </h2>
          <p>
            Для работы сервиса мы полагаемся на следующих провайдеров, которые обрабатывают данные
            от нашего имени:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Vercel</strong> — хостинг frontend и CDN.
            </li>
            <li>
              <strong>Render</strong> — хостинг backend.
            </li>
            <li>
              <strong>Cloudflare R2</strong> — object storage для загруженных и сгенерированных
              файлов.
            </li>
            <li>
              <strong>Supabase</strong> — PostgreSQL database для metadata вкладов.
            </li>
          </ul>
          <p>
            Мы <strong>не</strong> продаем ваши данные и <strong>не</strong> делимся ими для
            рекламы.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            7. Международная передача данных
          </h2>
          <p>
            Наши провайдеры работают по всему миру. Ваши данные могут обрабатываться в странах за
            пределами вашей собственной юрисдикции, включая страны вне ЕС/ЕЭЗ. Там, где это
            применимо, провайдеры используют standard contractual clauses для защиты передачи.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">8. Сроки хранения</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Загрузки save-файлов и local map uploads (Extract / Import / Delete / Commands / Map
              Viewer): удаляются сразу после обработки.
            </li>
            <li>Pending contributions в community map: хранятся до approval или rejection.</li>
            <li>
              Approved contributions в community map: <strong>хранятся бессрочно</strong> как часть
              общей карты и не могут быть отозваны по отдельности.
            </li>
            <li>
              Account profile: хранится до удаления аккаунта (см. раздел 9). При удалении аккаунт
              подвергается <strong>soft-delete</strong>: запись остается, но display name заменяется
              opaque tombstone, in-game name и opt-in flags очищаются, а API key отзывается.
            </li>
            <li>
              IP-hash bans: хранятся до истечения настроенного срока (по умолчанию 365 дней), затем
              игнорируются.
            </li>
            <li>Admin audit log: хранится бессрочно.</li>
            <li>
              Internal usage events (раздел 4c): хранятся бессрочно; soft-deleted accounts
              anonymised, но прошлые события остаются в aggregate counts.
            </li>
            <li>
              Saved routes (раздел 4d): хранятся бессрочно, чтобы сохранялась сопоставимость
              трендов.
            </li>
            <li>Backend access logs: хранятся согласно политике хостинг-провайдера.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">9. Ваши права</h2>
          <p>
            В зависимости от вашей юрисдикции (например, GDPR в ЕС/Великобритании или CCPA) у вас
            могут быть права на доступ, исправление, удаление, ограничение, перенос данных и
            возражение против обработки. Два из этих прав уже встроены в сервис:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Доступ / переносимость:</strong> страница <strong>Account</strong> в
              приложении предлагает экспорт данных в один клик (также доступен через
              <code className="rounded bg-muted px-1 text-xs">GET /api/account/export</code>),
              возвращающий ваш полный профиль аккаунта и metadata ваших вкладов в JSON.
            </li>
            <li>
              <strong>Удаление:</strong> страница <strong>Account</strong> позволяет самостоятельно
              удалить аккаунт в любой момент (также доступно через
              <code className="rounded bg-muted px-1 text-xs">DELETE /api/account/me</code>), что
              выполняет soft-delete, описанный в разделе 8.
            </li>
          </ul>
          <p>
            По любым другим запросам (исправление, ограничение, возражение или вопросы) напишите нам
            на{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
          <p>
            <strong>Важно:</strong> вклады в community map становятся частью aggregated dataset.
            После merge отдельный вклад невозможно идентифицировать или удалить — даже после
            удаления аккаунта. Учитывайте это перед отправкой данных.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">10. Дети</h2>
          <p>
            Сервис не предназначен для детей младше 13 лет (или младше 16 там, где этого требует
            местное законодательство). Если вы считаете, что ребенок использовал сервис, свяжитесь с
            нами, и мы удалим ему доступ.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">11. Безопасность</h2>
          <p>
            Трафик шифруется при передаче через HTTPS/TLS. Доступ к R2 и Supabase ограничен
            backend-сервисом. Для всех операций, изменяющих данные, требуются API keys. Идеально
            защищенных систем не бывает; пожалуйста, храните резервные копии своих save-файлов.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">12. Изменения этой политики</h2>
          <p>
            Мы можем обновлять эту политику. Существенные изменения будут увеличивать версию
            согласия, что заново покажет consent banner. Дата «Последнее обновление» вверху страницы
            отражает самую свежую редакцию.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">13. Контакты</h2>
          <p>
            Вопросы или запросы:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
