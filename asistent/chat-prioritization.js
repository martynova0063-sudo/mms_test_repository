const DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * DAY_MS;

const STATUS_ALIASES = new Map([
  ['INTERVIEW', 'INTERVIEW'],
  ['INTERVIEWING', 'INTERVIEW'],
  ['СОБЕСЕДОВАНИЕ', 'INTERVIEW'],
  ['СОБЕСЕДОВАНИЕ НАЗНАЧЕНО', 'INTERVIEW'],
  ['APPLIED', 'APPLIED'],
  ['APPLICATION', 'APPLIED'],
  ['ОТКЛИК', 'APPLIED'],
  ['ОТКЛИКНУЛСЯ', 'APPLIED'],
  ['REJECTED', 'REJECTED'],
  ['DECLINED', 'REJECTED'],
  ['REFUSED', 'REJECTED'],
  ['ОТКАЗ', 'REJECTED'],
  ['ОТКАЗАНО', 'REJECTED'],
]);

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return STATUS_ALIASES.get(normalized) || normalized || 'UNKNOWN';
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function elapsedMs(now, value) {
  const date = toDate(value);
  if (!date) return null;
  const elapsed = now.getTime() - date.getTime();
  return elapsed >= 0 ? elapsed : null;
}

function isRecent(now, value, windowMs = DAY_MS) {
  const elapsed = elapsedMs(now, value);
  return elapsed !== null && elapsed <= windowMs;
}

function getChatPriority(chat, now = new Date()) {
  const status = normalizeStatus(chat.status);
  const reasons = [];

  if (status === 'INTERVIEW') {
    reasons.push('INTERVIEW');
  }

  const waitingSince =
    chat.last_response_at || chat.applied_at || chat.created_at;
  const waitingMs = elapsedMs(now, waitingSince);
  if (status === 'APPLIED' && waitingMs !== null && waitingMs > THREE_DAYS_MS) {
    reasons.push('NO_RESPONSE_3_DAYS');
  }

  const hasRecentMessage = isRecent(
    now,
    chat.new_message_at ||
      (String(chat.last_message_direction || 'incoming').toLowerCase() !==
      'outgoing'
        ? chat.last_message_at
        : null),
  );
  if (hasRecentMessage) {
    reasons.push('NEW_MESSAGE_24_HOURS');
  }

  return {
    isHot: reasons.length > 0,
    priority: reasons.length > 0 ? 'HOT' : 'ARCHIVE',
    reasons,
    status,
    waitingDays:
      waitingMs === null ? null : Math.floor(waitingMs / DAY_MS),
  };
}

function isWithinLastDay(now, value) {
  return isRecent(now, value, DAY_MS);
}

function summarizeChats(chats, now = new Date()) {
  const companies = new Map();
  let hot = 0;
  let newMessages = 0;
  let newApplications = 0;
  let applications = 0;
  let refusals = 0;
  let interviews = 0;

  for (const chat of chats) {
    const priority = getChatPriority(chat, now);
    const status = priority.status;
    const company = String(chat.company || chat.from || 'Без компании').trim();
    const companyStats = companies.get(company) || {
      company,
      total: 0,
      hot: 0,
      applications: 0,
      newApplications: 0,
      refusals: 0,
      interviews: 0,
      newMessages: 0,
    };

    companyStats.total += 1;
    if (priority.isHot) {
      hot += 1;
      companyStats.hot += 1;
    }
    if (status === 'APPLIED') {
      applications += 1;
      companyStats.applications += 1;
      if (isWithinLastDay(now, chat.applied_at || chat.created_at)) {
        newApplications += 1;
        companyStats.newApplications += 1;
      }
    }
    if (status === 'REJECTED') {
      refusals += 1;
      companyStats.refusals += 1;
    }
    if (status === 'INTERVIEW') {
      interviews += 1;
      companyStats.interviews += 1;
    }
    if (
      isWithinLastDay(
        now,
        chat.new_message_at ||
          (String(chat.last_message_direction || 'incoming').toLowerCase() !==
          'outgoing'
            ? chat.last_message_at
            : null),
      )
    ) {
      newMessages += 1;
      companyStats.newMessages += 1;
    }

    companies.set(company, companyStats);
  }

  return {
    total: chats.length,
    hot,
    archive: chats.length - hot,
    newMessages,
    newApplications,
    applications,
    refusals,
    interviews,
    companies: Array.from(companies.values()).sort(
      (a, b) => b.hot - a.hot || b.total - a.total || a.company.localeCompare(b.company),
    ),
  };
}

module.exports = {
  DAY_MS,
  normalizeStatus,
  getChatPriority,
  summarizeChats,
};