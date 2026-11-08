import { francAll } from 'franc-min';

export function foldSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

// These phrases describe intent, so a translated query still ranks the same
// canonical tool names and uses the same schemas and dispatchers.
const VOCABULARY = {
  en: {
    read: 'read|show|view|see|get|display|check',
    list: 'list|enumerate',
    recent: 'recent|latest|newest|last',
    search: 'search|find|look for',
    create: 'create|add|make|schedule|set up',
    build: 'build|design|architect|redesign',
    delete: 'delete|remove',
    assign: 'assign|grant|give|add role',
    send: 'send|post|publish',
    edit: 'edit|modify|update|rename',
    message: 'message|messages',
    channel: 'channel|channels',
    role: 'role|roles',
    member: 'member|members|user|users',
    guild: 'guild|server|community',
    event: 'event|events',
    audit: 'audit log|audit logs',
    permission: 'permission|permissions',
    pin: 'pin|pins|pinned',
    invite: 'invite|invites|invitation|invitations',
    automod: 'automod|auto moderation',
  },
  vi: {
    read: 'đọc|xem|lấy|hiển thị|cho xem|kiểm tra',
    list: 'liệt kê|danh sách',
    recent: 'gần đây|mới nhất|mới đây|vừa rồi',
    search: 'tìm|tìm kiếm|tra cứu',
    create: 'tạo|thêm|lập|lên lịch|đặt lịch',
    build: 'dựng|xây dựng|thiết kế',
    delete: 'xóa|xoá|gỡ|loại bỏ',
    assign: 'gán|cấp|trao|gắn',
    send: 'gửi|đăng|nhắn cho',
    edit: 'sửa|chỉnh sửa|đổi tên|cập nhật',
    message: 'tin nhắn|thông điệp',
    channel: 'kênh|phòng chat|kênh thoại',
    role: 'vai trò|chức vụ',
    member: 'thành viên|người dùng',
    guild: 'máy chủ|cộng đồng',
    event: 'sự kiện|buổi hẹn',
    audit: 'nhật ký kiểm toán|nhật ký hoạt động',
    permission: 'quyền|quyền hạn|phân quyền',
    pin: 'ghim|đã ghim',
    invite: 'lời mời|link mời|liên kết mời',
    automod: 'kiểm duyệt tự động',
  },
  ko: {
    read: '읽어|읽기|보여|보기|확인|조회',
    list: '목록|나열',
    recent: '최근|최신',
    search: '찾아|찾기|검색',
    create: '만들|생성|추가|예약',
    build: '구축|설계',
    delete: '삭제|지워|제거',
    assign: '부여|할당|지급',
    send: '보내|전송|게시',
    edit: '수정|편집|변경',
    message: '메시지|메세지',
    channel: '채널',
    role: '역할',
    member: '멤버|회원|사용자|구성원',
    guild: '서버|커뮤니티',
    event: '이벤트|일정',
    audit: '감사 로그|감사 기록',
    permission: '권한',
    pin: '고정',
    invite: '초대',
    automod: '자동 관리|자동 검열',
  },
  ja: {
    read: '読んで|読む|見せ|表示|確認|取得',
    list: '一覧|リスト',
    recent: '最新|最近|直近',
    search: '検索|探して|探す',
    create: '作成|作って|追加|予約',
    build: '構築|設計',
    delete: '削除|消して',
    assign: '付与|割り当て|付けて',
    send: '送信|送って|投稿',
    edit: '編集|変更|更新',
    message: 'メッセージ',
    channel: 'チャンネル|チャネル',
    role: 'ロール|役職',
    member: 'メンバー|ユーザー',
    guild: 'サーバー|コミュニティ',
    event: 'イベント',
    audit: '監査ログ|監査記録',
    permission: '権限',
    pin: 'ピン留め|固定',
    invite: '招待',
    automod: '自動モデレーション',
  },
  zh: {
    read: '读取|查看|顯示|显示|查阅|查閱',
    list: '列出|列表|清單',
    recent: '最新|最近',
    search: '搜索|搜尋|查找|尋找',
    create: '创建|建立|新建|新增|添加',
    build: '搭建|建置|設計|设计',
    delete: '删除|刪除|移除',
    assign: '分配|授予|指派',
    send: '发送|發送|发布|發布',
    edit: '编辑|編輯|修改|更新',
    message: '消息|訊息|信息',
    channel: '频道|頻道',
    role: '角色|身分組|身份组',
    member: '成员|成員|用户|用戶',
    guild: '服务器|伺服器|社群',
    event: '活动|活動|事件',
    audit: '审计日志|稽核記錄|審核日誌',
    permission: '权限|權限',
    pin: '置顶|置頂|釘選',
    invite: '邀请|邀請',
    automod: '自动审核|自動審核',
  },
  es: {
    read: 'leer|lee|ver|muestra|mostrar|revisa|revisar',
    list: 'lista|listar|enumera|enumerar',
    recent: 'reciente|recientes|último|últimos|últimas',
    search: 'busca|buscar|encuentra|encontrar',
    create: 'crea|crear|añade|añadir|programa|programar',
    build: 'construye|construir|diseña|diseñar|monta',
    delete: 'borra|borrar|elimina|eliminar',
    assign: 'asigna|asignar|otorga|otorgar',
    send: 'envía|enviar|publica|publicar',
    edit: 'edita|editar|modifica|modificar|renombra',
    message: 'mensaje|mensajes',
    channel: 'canal|canales',
    role: 'rol|roles',
    member: 'miembro|miembros|usuario|usuarios',
    guild: 'servidor|comunidad',
    event: 'evento|eventos',
    audit: 'registro de auditoría|registros de auditoría',
    permission: 'permiso|permisos',
    pin: 'fijado|fijados|anclado|anclados',
    invite: 'invitación|invitaciones',
    automod: 'moderación automática',
  },
  fr: {
    read: 'lis|lire|voir|affiche|afficher|consulte|consulter',
    list: 'liste|lister|énumère',
    recent: 'récent|récents|derniers|dernières',
    search: 'cherche|chercher|recherche|rechercher|trouve',
    create: 'crée|créer|ajoute|ajouter|planifie|planifier',
    build: 'construis|construire|conçois|concevoir',
    delete: 'supprime|supprimer|efface|effacer',
    assign: 'attribue|attribuer|assigne|donne',
    send: 'envoie|envoyer|publie|publier',
    edit: 'modifie|modifier|renomme|éditer',
    message: 'message|messages',
    channel: 'salon|salons|canal|canaux',
    role: 'rôle|rôles',
    member: 'membre|membres|utilisateur|utilisateurs',
    guild: 'serveur|communauté',
    event: 'événement|événements|évènement|évènements',
    audit: 'journal d audit|journaux d audit',
    permission: 'permission|permissions|autorisations',
    pin: 'épinglé|épinglés',
    invite: 'invitation|invitations',
    automod: 'modération automatique',
  },
  de: {
    read: 'lies|lesen|zeige|anzeigen|ansehen|prüfe',
    list: 'liste|auflisten',
    recent: 'letzte|letzten|neuesten|kürzliche',
    search: 'suche|suchen|finde|finden',
    create: 'erstelle|erstellen|plane|planen|hinzufügen',
    build: 'baue|bauen|einrichten|entwirf',
    delete: 'lösche|löschen|entferne|entfernen',
    assign: 'weise|zuweisen|vergebe|vergeben',
    send: 'sende|senden|schicke|schicken',
    edit: 'ändere|ändern|bearbeiten|umbenennen',
    message: 'nachricht|nachrichten',
    channel: 'kanal|kanäle|kanals',
    role: 'rolle|rollen',
    member: 'mitglied|mitglieder|benutzer',
    guild: 'server|gemeinschaft',
    event: 'veranstaltung|veranstaltungen|termin',
    audit: 'audit protokoll|audit log|prüfprotokoll',
    permission: 'berechtigung|berechtigungen',
    pin: 'angeheftet|angeheftete',
    invite: 'einladung|einladungen',
    automod: 'automatische moderation',
  },
  pt: {
    read: 'leia|ler|veja|ver|mostre|mostrar|consulte',
    list: 'liste|listar',
    recent: 'recente|recentes|último|últimos|últimas',
    search: 'procure|procurar|busque|buscar|pesquise|pesquisar',
    create: 'crie|criar|adicione|adicionar|agende|agendar',
    build: 'monte|montar|construa|construir',
    delete: 'apague|apagar|exclua|excluir|remova|remover',
    assign: 'atribua|atribuir|conceda|conceder',
    send: 'envie|enviar|publique|publicar',
    edit: 'edite|editar|altere|alterar|renomeie',
    message: 'mensagem|mensagens',
    channel: 'canal|canais',
    role: 'cargo|cargos|função|funções',
    member: 'membro|membros|usuário|usuários',
    guild: 'servidor|comunidade',
    event: 'evento|eventos',
    audit: 'registro de auditoria|log de auditoria',
    permission: 'permissão|permissões',
    pin: 'fixado|fixadas|fixados',
    invite: 'convite|convites',
    automod: 'moderação automática',
  },
} as const;

export type Concept = keyof typeof VOCABULARY.en;
const CJK = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const FUNCTION_WORDS = {
  en: 'the|this|with|my|our|please|for',
  vi: 'trong|cua|nay|toi|cho|hay|mot|tat ca',
  es: 'los|las|este|del|todos|mi|un|una|para',
  fr: 'les|du|dans|mon|tous|pour|ce|cette',
  de: 'der|die|das|den|auf|meinem|alle|einem',
  pt: 'o|os|as|este|do|da|no|um|uma|meu|todos|para',
} as const;
const markers = new Map<string, string[]>(
  Object.entries(FUNCTION_WORDS).map(([lang, words]) => [lang, words.split('|')]),
);

const phrases = Object.entries(VOCABULARY).flatMap(([language, concepts]) =>
  Object.entries(concepts).flatMap(([concept, aliases]) =>
    [...new Set(aliases.split('|').map(foldSearchText))].map((alias) => ({
      language,
      concept: concept as Concept,
      alias,
      needle: CJK.test(alias) ? alias : ` ${alias} `,
    })),
  ),
);

// Shared spellings are useful retrieval evidence, but weak language evidence.
const phraseLanguages = new Map<string, Set<string>>();
for (const { alias, language } of phrases) {
  const languages = phraseLanguages.get(alias) ?? new Set<string>();
  languages.add(language);
  phraseLanguages.set(alias, languages);
}

export function queryIntent(original: string, folded: string) {
  const concepts = new Set<Concept>();
  const evidence = new Map<string, Set<Concept>>();
  const bounded = ` ${folded} `;
  for (const { needle, alias, language, concept } of phrases) {
    if (!bounded.includes(needle)) continue;
    concepts.add(concept);
    if (phraseLanguages.get(alias)?.size !== 1) continue;
    const hits = evidence.get(language) ?? new Set<Concept>();
    hits.add(concept);
    evidence.set(language, hits);
  }

  const ranked = Object.keys(VOCABULARY)
    .map((language) => ({
      language,
      score:
        2 * (evidence.get(language)?.size ?? 0) +
        Math.min(
          3,
          (markers.get(language) ?? []).filter((word) => bounded.includes(` ${word} `)).length,
        ),
    }))
    .sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  const clean = original
    .replace(/https?:\/\/\S+|<[@#][!&]?\d+>|\b\w+_\w+\b|\b\d+\b/gu, ' ')
    .replace(/[^\p{L}\p{M} ]+/gu, ' ')
    .trim();
  let language = 'und';
  if (HANGUL.test(clean) && !KANA.test(clean)) {
    language = 'ko';
  } else if (KANA.test(clean) && !HANGUL.test(clean)) {
    language = 'ja';
  } else if (first !== undefined && first.score >= 3 && first.score > (second?.score ?? 0)) {
    language = first.language;
  } else if (clean.length >= 12) {
    const [top, next] = francAll(clean);
    if (top !== undefined && top[0] !== 'und' && top[1] - (next?.[1] ?? 0) >= 0.12) {
      language = new Intl.Locale(top[0]).language;
    }
  }
  return { language, concepts };
}
