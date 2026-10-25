// 与 lib/contract.js 的枚举保持一致（前端单独一份，避免把 zod 打进 bundle）
export const ERROR_TYPES = {
  grammar: '语法',
  lexical: '词汇',
  cohesion: '衔接',
  task_response: '切题',
  coherence: '连贯',
};

export const ERROR_TAGS = {
  prep_collocation: '介词搭配',
  tense_shift: '时态乱跳',
  weak_argument: '论证弱',
  article_misuse: '冠词错',
  word_form: '词性错',
  incomplete_answer: '答题不完整',
  subj_verb_agree: '主谓不一致',
  linker_overuse: '连接词过度',
  basic_vocabulary: '词汇基础',
  conditional: '条件句错',
  copy_question: '抄题目',
  informal_register: '口语化',
  passive_overuse: '被动语态过度',
  run_on: '流水句',
  paragraph_structure: '段落结构',
};

export const DIM_META = [
  { key: 'tr', label: 'TA / TR', cn: '任务回应' },
  { key: 'cc', label: 'CC', cn: '连贯与衔接' },
  { key: 'lr', label: 'LR', cn: '词汇资源' },
  { key: 'ga', label: 'GA', cn: '语法多样与准确' },
];
