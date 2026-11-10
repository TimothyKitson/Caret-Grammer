// The grammar, punctuation and style checks.
//
// Every rule is a regular expression over the whole field plus a way to build
// the replacement. A rule may underline a capture group instead of the whole
// match (`group: 2`), refuse a match after a second look (`exclude`), and only
// run on real prose rather than on a search box (`prose: true`).
//
// Precision is the priority: a wrong underline is worse than a missed one, so
// the patterns look for context ("their is" rather than every "their") and
// anything genuinely ambiguous is either left out or filed under `style`,
// which the options page can switch off.

import { inSkipRange } from './tokenize.js';
import { matchCase, fillTemplate } from './text-util.js';
import { NAME_STATED, NAME_TITLE, NAME_GREETING, NAME_ADDRESSED } from './spelling.js';

const alt = (words) => words.join('|');

// Is the word at `index` the first word of a clause: the start of the text or
// of a line, after sentence punctuation, an opening quote or bracket, or a
// conjunction?
//
// Rules about a SUBJECT need this. "It don't matter" is a mistake; "people who
// try it don't regret it" is not, and neither is "a photo of me and my dad
// fishing". The pronoun is the same word in both - what differs is whether it
// is doing the action, and in English the one doing the action opens the
// clause. Without this check those rules underlined ordinary correct
// sentences, which is the one thing this checker must not do.
const CLAUSE_OPENER = new RegExp(
  '(?:^|[.!?;:\\n(\\[“"‘—–]\\s*|\\b(?:'
  + 'and|but|or|so|yet|because|cause|cos|if|when|while|though|although|since|unless|whether'
  + '|then|that|as|once|after|before|until'
  // verbs that introduce a whole clause: whatever follows them is its subject
  + '|think|thinks|thought|know|knows|knew|say|says|said|hope|hopes|hoped|guess'
  + '|believe|believes|believed|feel|feels|felt|mean|means|reckon|realize|realized'
  + '|realise|realised|bet|swear|heard|noticed'
  + ')\\s+)$', 'i',
);
const CLAUSE_OPENER_OR_COMMA = /(?:,\s+)$/;

function atClauseStart(doc, index, { comma = true } = {}) {
  const haystack = doc.normalized || doc.text;
  const before = haystack.slice(Math.max(0, index - 14), index);
  return CLAUSE_OPENER.test(before) || (comma && CLAUSE_OPENER_OR_COMMA.test(before));
}

// An auxiliary, or a verb like let / make / see / help, puts the next verb in
// its plain form whatever the subject: "does he have", "will it have", "let it
// have a rest", "did she do".
const TAKES_PLAIN_VERB = /\b(?:do|does|did|will|would|can|could|shall|should|may|might|must|let|lets|make|makes|made|help|helps|helped|see|sees|saw|watch|watches|watched|hear|hears|heard|have|has|had)(?:n['’]t)?\s+(?:not\s+)?$/i;
// "I suggest that he have a look" - the subjunctive after asking or insisting.
const MANDATIVE = /\b(?:suggest|recommend|insist|demand|request|propose|require|ask|urge|prefer|important|essential|vital|necessary|crucial|imperative)\w*\s+(?:that\s+)?$/i;
// "if it were", "as though he were", "I wish it were Friday".
const IRREALIS = /\b(?:if|though|wish|wished|wishes|suppose|imagine|unless)\s+$/i;
// Only ever subjects, so no position test is needed for these.
const SUBJECT_ONLY = /^(?:he|she|they|we|i)$/i;
// A determiner in front of a noun subject: "the kids", "our parents".
const DETERMINER = /\b(?:the|these|those|our|my|your|their|his|her|its|all\s+the|some|many|most|both)\s+$/i;

/**
 * Is `word`, sitting at `index`, really the subject that `verb` agrees with?
 *
 * The agreement rules are all "word next to verb" patterns, and a word next to
 * a verb is often not its subject at all: "things that don't work", "one of
 * the teachers was", "does he have time", "thank you is not enough", "if it
 * were true". Each of those was being underlined. This says no for all of
 * them, and yes for "he don't know", "the kids is outside", "it were broken".
 */
function isTheSubject(doc, index, word, verb) {
  const haystack = doc.normalized || doc.text;
  const before = haystack.slice(Math.max(0, index - 40), index);
  if (TAKES_PLAIN_VERB.test(before) || MANDATIVE.test(before)) return false;
  if (/^were$/i.test(verb) && IRREALIS.test(before)) return false;
  if (SUBJECT_ONLY.test(word)) return true;

  // it, you, this, these, those and nouns can all be objects too, so they only
  // count as the subject when they open the clause - or, for a noun, when its
  // determiner does.
  if (/\bof\s+$/i.test(before) || /\bof\s+\S+\s+$/i.test(before)) return false;   // "one of the kids is"
  if (/^thank$/i.test(before.trim().split(/\s+/).pop() || '') && /^you$/i.test(word)) return false;
  if (atClauseStart(doc, index)) return true;
  const det = before.match(DETERMINER);
  return !!det && atClauseStart(doc, index - (before.length - det.index) + (det[0].length - det[0].trimStart().length));
}

// ---------------------------------------------------------------------------
// word lists
// ---------------------------------------------------------------------------

// "have went" -> "have gone"
const PARTICIPLES = {
  went: 'gone', ate: 'eaten', drank: 'drunk', saw: 'seen', wrote: 'written',
  took: 'taken', came: 'come', did: 'done', ran: 'run', began: 'begun',
  broke: 'broken', chose: 'chosen', drove: 'driven', forgot: 'forgotten',
  gave: 'given', knew: 'known', spoke: 'spoken', swam: 'swum', threw: 'thrown',
  wore: 'worn', rang: 'rung', sang: 'sung', shrank: 'shrunk', stole: 'stolen',
  swore: 'sworn', tore: 'torn', woke: 'woken', fell: 'fallen', flew: 'flown',
  froze: 'frozen', grew: 'grown', hid: 'hidden', rode: 'ridden', rose: 'risen',
  shook: 'shaken', sank: 'sunk', blew: 'blown', drew: 'drawn', bit: 'bitten',
  arose: 'arisen', mistook: 'mistaken', spoke_: 'spoken',
};

// "will went" -> "will go"
const BASE_FORMS = {
  went: 'go', ate: 'eat', drank: 'drink', saw: 'see', wrote: 'write',
  took: 'take', began: 'begin', broke: 'break', chose: 'choose',
  drove: 'drive', forgot: 'forget', gave: 'give', knew: 'know',
  spoke: 'speak', swam: 'swim', threw: 'throw', wore: 'wear', rang: 'ring',
  sang: 'sing', stole: 'steal', swore: 'swear', tore: 'tear', woke: 'wake',
  fell: 'fall', flew: 'fly', froze: 'freeze', grew: 'grow', hid: 'hide',
  rode: 'ride', rose: 'rise', shook: 'shake', sank: 'sink', blew: 'blow',
  drew: 'draw', had: 'have', said: 'say', got: 'get', made: 'make',
  thought: 'think', found: 'find', told: 'tell', became: 'become',
  left: 'leave', felt: 'feel', brought: 'bring', kept: 'keep', held: 'hold',
  sat: 'sit', stood: 'stand', lost: 'lose', paid: 'pay', met: 'meet',
  sent: 'send', spent: 'spend', built: 'build', bought: 'buy',
  caught: 'catch', taught: 'teach', sold: 'sell', heard: 'hear',
};

// Written without its apostrophe. Only forms that are not themselves ordinary
// words, plus a few that almost never mean the other thing.
const MISSING_APOSTROPHE = {
  cant: "can't", wont: "won't", dont: "don't", doesnt: "doesn't",
  didnt: "didn't", isnt: "isn't", arent: "aren't", wasnt: "wasn't",
  werent: "weren't", hasnt: "hasn't", havent: "haven't", hadnt: "hadn't",
  couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
  mustnt: "mustn't", aint: "ain't", im: "I'm", ive: "I've", youre: "you're",
  youve: "you've", youll: "you'll", theyre: "they're", theyve: "they've",
  theyll: "they'll", thats: "that's", whats: "what's", wheres: "where's",
  theres: "there's", heres: "here's", whos: "who's", oclock: "o'clock",
  yall: "y'all", shouldve: "should've", couldve: "could've",
  wouldve: "would've", mightve: "might've", gonna: 'going to',
  wanna: 'want to', gotta: 'got to', kinda: 'kind of', sorta: 'sort of',
  outta: 'out of', lotsa: 'lots of', cuz: 'because',
};

// Nouns that follow a possessive, used to tell "you're"/"your" apart.
const POSSESSED = [
  'dog', 'dogs', 'cat', 'cats', 'car', 'cars', 'house', 'home', 'room',
  'book', 'books', 'phone', 'laptop', 'computer', 'job', 'name', 'turn',
  'fault', 'idea', 'ideas', 'question', 'questions', 'answer', 'email',
  'emails', 'address', 'number', 'account', 'password', 'order', 'payment',
  'family', 'kids', 'children', 'son', 'daughter', 'wife', 'husband',
  'parents', 'mom', 'dad', 'mother', 'father', 'friend', 'friends', 'team',
  'company', 'business', 'website', 'site', 'school', 'class', 'teacher',
  'money', 'help', 'opinion', 'thoughts', 'response', 'reply', 'message',
  'letter', 'photo', 'picture', 'profile', 'birthday', 'choice', 'decision',
  'plan', 'plans', 'goal', 'goals', 'health', 'hair', 'face', 'hands',
  'shoes', 'clothes', 'office', 'desk', 'keys', 'wallet', 'bag',
  'note', 'notes', 'form', 'forms', 'permission', 'slip', 'comment',
  'comments', 'feedback', 'homework', 'project', 'essay', 'paper', 'grade',
  'grades', 'test', 'quiz', 'lunch', 'jacket', 'coat', 'backpack', 'folder',
  'binder', 'tablet', 'appointment', 'invoice', 'receipt', 'signature',
  'schedule', 'calendar', 'password', 'username', 'birthday', 'invitation',
];

const BEING_VERBS = [
  'going', 'coming', 'doing', 'trying', 'working', 'looking', 'waiting',
  'talking', 'playing', 'running', 'sitting', 'standing', 'making', 'taking',
  'getting', 'giving', 'saying', 'telling', 'asking', 'helping', 'leaving',
  'staying', 'moving', 'planning', 'thinking', 'hoping', 'starting',
];

const WORDY = {
  'in order to': 'to',
  'in order for': 'for',
  'due to the fact that': 'because',
  'owing to the fact that': 'because',
  'in spite of the fact that': 'although',
  'despite the fact that': 'although',
  'in the event that': 'if',
  'in the event of': 'if',
  'at this point in time': 'now',
  'at the present time': 'now',
  'at this time': 'now',
  'in the near future': 'soon',
  'on a daily basis': 'daily',
  'on a weekly basis': 'weekly',
  'on a regular basis': 'regularly',
  'a large number of': 'many',
  'a great deal of': 'much',
  'the majority of': 'most',
  'a sufficient amount of': 'enough',
  'has the ability to': 'can',
  'have the ability to': 'can',
  'is able to': 'can',
  'are able to': 'can',
  'take into consideration': 'consider',
  'make a decision': 'decide',
  'provide assistance': 'help',
  'give consideration to': 'consider',
  'for the purpose of': 'to',
  'with regard to': 'about',
  'with reference to': 'about',
  'in reference to': 'about',
  'in regards to': 'regarding',
  'in relation to': 'about',
  'in terms of': 'for',
  'prior to': 'before',
  'subsequent to': 'after',
  'as a matter of fact': 'in fact',
  'utilize': 'use',
  'utilizes': 'uses',
  'utilized': 'used',
  'utilization': 'use',
  'endeavor to': 'try to',
  'ascertain': 'find out',
  'commence': 'start',
  'terminate': 'end',
  'purchase': 'buy',
  'facilitate': 'help',
  'demonstrate': 'show',
  'sufficient': 'enough',
  'numerous': 'many',
  'obtain': 'get',
  'require': 'need',
};

// Phrases with nothing to put in their place: the fix is to cut them.
const DELETABLE = [
  'in the process of',
  'it is important to note that',
  'it should be noted that',
  'needless to say',
  'for all intents and purposes',
  'at the end of the day',
  'when all is said and done',
  'in my honest opinion',
  'as far as I am concerned',
];

const REDUNDANT = {
  'each and every': 'every',
  'first and foremost': 'first',
  'basic fundamentals': 'fundamentals',
  'absolutely essential': 'essential',
  'completely eliminate': 'eliminate',
  'end result': 'result',
  'final outcome': 'outcome',
  'past history': 'history',
  'future plans': 'plans',
  'free gift': 'gift',
  'new innovation': 'innovation',
  'unexpected surprise': 'surprise',
  'very unique': 'unique',
  'most unique': 'unique',
  'atm machine': 'ATM',
  'pin number': 'PIN',
  'advance planning': 'planning',
  'added bonus': 'bonus',
  'close proximity': 'proximity',
  'exact same': 'same',
  'join together': 'join',
  'merge together': 'merge',
  'combine together': 'combine',
  'plan ahead': 'plan',
  'repeat again': 'repeat',
  'revert back': 'revert',
  'return back': 'return',
  'rise up': 'rise',
  'sum total': 'total',
  'true fact': 'fact',
  'unexpected emergency': 'emergency',
  'my personal opinion': 'my opinion',
  'time period': 'period',
  '12 midnight': 'midnight',
  '12 noon': 'noon',
};

// Words where "a" is right even though they start with a vowel letter, and
// vice versa: the sound is what matters.
const CONSONANT_SOUND = /^(?:u(?:n[ai]|ni|se|su|ti|to|ku|ku)|eu|one(?![a-z])|once|ouija|ubiq|ufo|urin(?:al|ary))/i;
const VOWEL_SOUND = /^(?:hour|honest|honor|honour|heir|homage|hombre|herb(?:s|al)?(?![a-z])|habitue)/i;
// Letters whose name starts with a vowel sound: an F, an MRI, an SEO report.
const VOWEL_LETTERS = /^[FHLMNRSX]/;

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

const RULES = [
  // ---- confusable words -------------------------------------------------
  {
    id: 'your-youre',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(your)\\s+(?:${alt(['welcome', 'going', 'gonna', 'kidding', 'joking', 'mistaken', 'awesome', 'amazing', 'invited', 'fired', 'hired', 'correct', 'wrong', 'not', 'never', 'always', 'still', 'already', 'probably', 'definitely', 'absolutely', 'the\\s+best', 'the\\s+worst', 'so\\s+\\w+', 'too\\s+\\w+', 'right\\b(?!\\s+(?:hand|arm|leg|eye|ear|side|foot|shoulder|now|to|of|about))'])})\\b`, 'gi'),
    group: 1,
    message: '“Your” is possessive. Here you want the contraction of “you are”.',
    suggest: () => ["you're"],
  },
  {
    id: 'youre-your',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(you\\s*['’]\\s*re)\\s+(?:${alt(POSSESSED)})\\b`, 'gi'),
    group: 1,
    message: '“You’re” means “you are”. Here you want the possessive.',
    suggest: () => ['your'],
  },
  {
    id: 'their-there',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(their)\s+(?:is|are|was|were|isn't|aren't|wasn't|weren't|will\s+be|has\s+been|have\s+been|seems|seem|appears|appear|might\s+be|may\s+be|could\s+be|should\s+be|would\s+be)\b/gi,
    group: 1,
    message: '“Their” is possessive. Use “there” for a place or for “there is”.',
    suggest: () => ['there'],
  },
  {
    id: 'there-their',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(there)\\s+(?:${alt(POSSESSED.concat(['own', 'responsibility', 'lives', 'hearts', 'minds', 'heads', 'stuff', 'things', 'neighborhood']))})\\b`, 'gi'),
    group: 1,
    message: '“There” is a place. Use “their” for something they own.',
    suggest: () => ['their'],
  },
  {
    id: 'there-theyre',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(there)\\s+(?:${alt(BEING_VERBS)})\\b`, 'gi'),
    group: 1,
    message: 'Did you mean “they’re” (they are) or “there’s” (there is)?',
    suggest: () => ["they're", "there's"],
  },
  {
    id: 'their-theyre',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(their)\\s+(?:${alt(BEING_VERBS)})\\b`, 'gi'),
    group: 1,
    message: '“Their” is possessive. Use “they’re” for “they are”.',
    suggest: () => ["they're"],
  },
  {
    id: 'theyre-their',
    category: 'grammar',
    short: 'Confused words',
    re: new RegExp(`\\b(they\\s*['’]\\s*re)\\s+(?:${alt(POSSESSED.concat(['own', 'lives', 'stuff', 'things']))})\\b`, 'gi'),
    group: 1,
    message: '“They’re” means “they are”. Use “their” for something they own.',
    suggest: () => ['their'],
  },
  {
    id: 'its-it-is',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(its)\s+(?:a|an|the|been|going|gonna|not|too|very|so|because|only|just|all|my|your|his|her|our|their|time\s+to|important|possible|impossible|clear|obvious|likely|unlikely|hard|easy|difficult|nice|good|bad|great|better|worse|best|worst|true|false|okay|fine|amazing|awesome|terrible|about\s+time|worth|always|never|still|already|probably|definitely|absolutely)\b/gi,
    group: 1,
    message: '“Its” is possessive. “It’s” is short for “it is”.',
    suggest: () => ["it's"],
  },
  {
    id: 'it-is-its',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(it\s*['’]\s*s)\s+(?:own|color|colour|name|shape|size|value|purpose|weight|edges|surface|contents|head|tail|price|cost|origin|meaning|title|author|design|role|position|location|width|height|length|depth|volume|speed|strength|quality|features|benefits|effects|impact|users|members|parts|sides|walls|roof|engine|battery|screen)\b/gi,
    group: 1,
    message: '“It’s” means “it is”. The possessive has no apostrophe.',
    suggest: () => ['its'],
  },
  {
    id: 'then-than',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:better|worse|more|less|other|rather|greater|fewer|older|younger|larger|smaller|bigger|higher|lower|faster|slower|sooner|later|cheaper|easier|harder|stronger|weaker|taller|shorter|longer|nicer|different|no\s+later|none\s+other)\s+(then)\b/gi,
    group: 1,
    message: 'Comparisons use “than”. “Then” is about time.',
    suggest: () => ['than'],
  },
  {
    id: 'than-then',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:and|but|so)\s+(than)\s+(?:I|we|you|they|he|she|it)\b/gi,
    group: 1,
    message: '“Than” compares. For a sequence of events use “then”.',
    suggest: () => ['then'],
  },
  {
    id: 'to-too',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(to)\s+(?:much|many|late|early|small|big|large|hot|cold|often|soon|far|low|high|fast|slow|expensive|cheap|hard|easy|long|short|tired|busy|loud|quiet|heavy|light|young|difficult|complicated|risky|noisy|crowded)\b/gi,
    group: 1,
    message: '“Too” means excessively.',
    suggest: () => ['too'],
  },
  {
    id: 'too-to',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:want|wants|wanted|need|needs|needed|going|got|like|likes|liked|try|tries|tried|able|ought|used|hope|hopes|hoped|plan|plans|planned|decided|refused|agreed|seems|seemed|started|began|continued|forgot|remembered|had|has|have)\s+(too)\s+(?:[a-z])/g,
    group: 1,
    message: '“To” belongs before a verb. “Too” means excessively.',
    suggest: () => ['to'],
  },
  {
    id: 'could-of',
    category: 'grammar',
    short: 'Verb form',
    re: /\b(could|should|would|must|might|may)\s+(of)\b/gi,
    message: 'Write “$1 have”: “of” only sounds like “’ve”.',
    suggest: (m) => [`${m[1]} have`, `${m[1]}'ve`],
  },
  {
    id: 'loose-lose',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(loose)\s+(?:weight|money|control|track|interest|hope|faith|sight|touch|patience|focus|balance|sleep|count|my|your|his|her|their|our|it|the\s+game|the\s+match|the\s+election|a\s+game|your\s+mind)\b/gi,
    group: 1,
    message: '“Lose” is the verb. “Loose” means not tight.',
    suggest: () => ['lose'],
  },
  {
    id: 'loose-lose-subject',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:I|we|you|they|don't|doesn't|didn't|will|would|might|could|can|to)\s+(loose)\b/gi,
    group: 1,
    message: '“Lose” is the verb. “Loose” means not tight.',
    suggest: () => ['lose'],
  },
  {
    id: 'affect-effect',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:the|an|any|no|some|little|big|major|minor|side|adverse|positive|negative|desired|lasting|domino|ripple)\s+(affects?)\b/gi,
    group: 1,
    message: 'The noun is “effect”. “Affect” is the verb.',
    suggest: (m) => [m[1].toLowerCase() === 'affects' ? 'effects' : 'effect'],
  },
  {
    id: 'effect-affect',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(effect(?:s|ed|ing))\s+(?:me|us|him|her|them|you|people|everyone|everybody|my|our|his|their|students|families|the\s+way)\b/gi,
    group: 1,
    message: 'To have an effect on something is to “affect” it.',
    suggest: (m) => [m[1].toLowerCase().replace(/^effect/, 'affect')],
  },
  {
    id: 'accept-except',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(accept)\s+(?:for|that\s+one|when|in\s+cases)\b/gi,
    group: 1,
    message: '“Except” means leaving something out.',
    suggest: () => ['except'],
  },
  {
    id: 'advice-advise',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:please|kindly|to|will|would|can|could|should|must)\s+(advice)\b/gi,
    group: 1,
    message: '“Advise” is the verb; “advice” is the noun.',
    suggest: () => ['advise'],
  },
  {
    id: 'advise-advice',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:good|bad|some|any|the|his|her|your|my|our|their|useful|helpful|sound|free|legal|medical|financial)\s+(advise)\b/gi,
    group: 1,
    message: '“Advice” is the noun; “advise” is the verb.',
    suggest: () => ['advice'],
  },
  {
    id: 'principle-principal',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:school|the|our|assistant|vice|elementary|high\s+school|middle\s+school)\s+(principle)\b/gi,
    group: 1,
    message: 'The head of a school is the “principal”.',
    suggest: () => ['principal'],
  },
  {
    id: 'principal-principle',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:moral|basic|guiding|first|scientific|fundamental|core|general|underlying)\s+(principals?)\b/gi,
    group: 1,
    message: 'A rule or belief is a “principle”.',
    suggest: (m) => [m[1].toLowerCase() === 'principals' ? 'principles' : 'principle'],
  },
  {
    id: 'weather-whether',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(weather)\s+or\s+not\b|\b(?:asked|wondered|know|knows|knew|decide|decided|see|tell|check|unsure|unclear|regardless\s+of)\s+(weather)\b/gi,
    group: 0,
    message: '“Whether” introduces a choice. “Weather” is rain and sun.',
    suggest: (m) => [m[0].replace(/weather/i, (w) => matchCase(w, 'whether'))],
  },
  {
    // "they where at the store" - a subject pronoun cannot be followed by
    // "where", so this one is unambiguous.
    id: 'where-were-subject',
    category: 'grammar',
    short: 'Confused words',
    // "they", "we" and "who" are only ever subjects, so "they where" is wrong
    // wherever it turns up - except straight after a form of "be", as in
    // "were they where it happened?".
    //
    // "you" is the awkward one: it is also an object, and "I'll show you where
    // it is" is perfectly good English. So "you where" only counts when "you"
    // opens the clause. "these" and "those" are not here at all: "those where
    // the answer is known can be skipped" is correct.
    re: /(?<!\b(?:were|was|are|is|am|be|been)\s)\b(they|we|who|you)\s+(where)\b(?!\s*\?)/gi,
    group: 2,
    message: '“Where” is a place. After a subject you want “were”.',
    suggest: () => ['were'],
    exclude: (m, doc) => m[1].toLowerCase() === 'you' && !atClauseStart(doc, m.index),
  },
  {
    // The idiom is "couldn't care less" - caring less is the whole point.
    id: 'could-care-less',
    category: 'grammar',
    short: 'Idiom',
    re: /\b(could\s+care\s+less)\b/gi,
    group: 1,
    message: 'The phrase is “couldn’t care less” — you care so little it could not go lower.',
    suggest: () => ["couldn't care less"],
  },
  {
    // "he don't" -> "he doesn't". Only for third-person singular subjects.
    id: 'dont-doesnt',
    category: 'grammar',
    short: 'Agreement',
    // Only he, she and it, and only when they open the clause. "that" and
    // "this" used to be in this list and flagged "things that don't work" and
    // "things like this don't happen"; "it" without the clause check flagged
    // "people who try it don't regret it". The indefinite pronouns are gone
    // too: "everybody don't move!" is an order, not a mistake.
    re: /\b(he|she|it)\s+(dont|do\s*nt)\b/gi,
    group: 2,
    message: 'A single person or thing “doesn’t”, not “don’t”.',
    suggest: () => ["doesn't"],
    exclude: (m, doc) => !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    // "neither of us have" -> has. Neither is singular, however many people it
    // is talking about. Same for either and each.
    //
    // Not "none": "none of them were ready" is standard English and always
    // has been.
    id: 'neither-of-us-have',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(?:neither|either|each)\s+of\s+(?:us|them|you|the\s+\w+|my\s+\w+|our\s+\w+|these|those)\s+(have|were|are|do|want|know|seem|need)\b/gi,
    group: 1,
    message: '“Neither”, “either” and “each” are singular, however many people they are talking about.',
    suggest: (m) => [{
      have: 'has', were: 'was', are: 'is', do: 'does',
      want: 'wants', know: 'knows', seem: 'seems', need: 'needs',
    }[m[1].toLowerCase()]],
    exclude: (m, doc) => {
      const before = (doc.normalized || doc.text).slice(Math.max(0, m.index - 40), m.index);
      // "Does either of you know", "Will each of them have", "I let each of
      // them have one": after an auxiliary, or a verb such as let, make or
      // see, the plain form of the verb is the right one.
      if (/\b(?:do|does|did|can|could|will|would|shall|should|may|might|must|let|lets|make|makes|made|help|helps|helped|see|sees|saw|watch|watches|watched|hear|hears|heard|have|has|had)(?:n['’]t)?\s+(?:not\s+)?$/i.test(before)) return true;
      // "I suggest that each of you have a look" - after a verb of asking or
      // insisting, "have" is the subjunctive and is correct.
      return /\b(?:suggest|recommend|insist|demand|request|propose|require|ask|urge|prefer|important|essential|vital|necessary|crucial|imperative)\w*\s+(?:that\s+)?$/i.test(before);
    },
  },
  {
    // "Me and the principal has been" - the verb is wrong, and so is "Me".
    // The pronoun rule below only handles "me and him", so this catches the
    // far more common "me and <somebody named>".
    id: 'me-and-someone',
    category: 'grammar',
    short: 'Pronouns',
    re: /\b(me)\s+and\s+(?:the|my|our|his|her|their)\s+\w+\s+(?=\w*(?:ed|ing)\b|(?:has|have|was|were|is|are|will|would|can|could|should|did|do|went|got|saw|took|made|said)\b)/gi,
    group: 1,
    message: 'When they are the ones doing the action, it is “… and I”.',
    suggest: () => ['I'],
    // "Me" is only wrong when it is doing the action, and then it opens the
    // clause. Everywhere else it is receiving the action and is correct: "she
    // told me and the principal", "a photo of me and my dad fishing", "he
    // watched me and my brother playing". Listing the verbs that can come
    // before it was tried first and cannot work - any verb can.
    exclude: (m, doc) => !atClauseStart(doc, m.index, { comma: false }),
  },
  {
    // "Me and him went" -> "He and I went". Only when a verb follows, so
    // "she told me and him" is left alone.
    id: 'me-and-subject',
    category: 'grammar',
    short: 'Pronouns',
    re: /\b(me\s+and\s+(him|her|them|he|she|they))\s+(?=\w*(?:ed|ing)\b|(?:went|are|were|was|is|will|would|can|could|should|have|has|had|did|do|got|saw|took|made|said|want|need|think|like|live|work|play|start|stay|left|came|run|ran)\b)/gi,
    group: 1,
    message: 'When they are the ones doing the action, it is “$$FIX$$”.',
    suggest: (m) => {
      const map = { him: 'he', her: 'she', them: 'they', he: 'he', she: 'she', they: 'they' };
      const who = map[m[2].toLowerCase()] || m[2];
      return [`${who[0].toUpperCase()}${who.slice(1)} and I`];
    },
    rawCase: true,
    // Same reasoning as the rule above: "he saw me and him talking" is right.
    exclude: (m, doc) => !atClauseStart(doc, m.index, { comma: false }),
  },
  {
    id: 'were-where',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(were)\s+(?:is|are|am|was)\b/gi,
    group: 1,
    message: 'Did you mean “where”?',
    suggest: () => ['where'],
  },
  {
    id: 'where-weare',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(where)\s+(?:glad|happy|sorry|excited|ready|proud|thrilled|delighted|going|coming|closed|open|done|finished|late|early)\b/gi,
    group: 1,
    message: 'Did you mean “we’re” (we are) or “were”?',
    suggest: () => ["we're", 'were'],
  },
  {
    id: 'lead-led',
    category: 'grammar',
    short: 'Verb form',
    re: /\b(?:has|have|had|was|were|is|are|been|being|which|that)\s+(lead)\s+(?:to|by|into|down|toward|towards|astray|us|me|them|him|her)\b/gi,
    group: 1,
    message: 'The past tense of “lead” is “led”.',
    suggest: () => ['led'],
  },
  {
    id: 'past-passed',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:has|have|had)\s+(past)\b|\b(past)\s+away\b/gi,
    group: 0,
    message: 'The verb is “passed”.',
    suggest: (m) => [m[0].replace(/past/i, (w) => matchCase(w, 'passed'))],
  },
  {
    id: 'passed-past',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(?:the|this|in\s+the|over\s+the)\s+(passed)\s+(?:year|years|month|months|week|weeks|day|days|decade|century|few)\b/gi,
    group: 1,
    message: 'Time gone by is “past”.',
    suggest: () => ['past'],
  },
  {
    id: 'quite-quiet',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(quite)\s+(?:room|place|down|please|time\s+alone)\b|\b(quiet)\s+(?:a\s+few|a\s+lot|a\s+bit|sure|good|nice|different|often|literally|frankly)\b/gi,
    group: 0,
    message: '“Quiet” means silent; “quite” means fairly or very.',
    suggest: (m) => [m[0].replace(/quiet|quite/i, (w) => matchCase(w, w.toLowerCase() === 'quiet' ? 'quite' : 'quiet'))],
  },
  {
    id: 'breath-breathe',
    category: 'grammar',
    short: 'Verb form',
    re: /\b(?:can|to|couldn't|can't|cannot|could|hard\s+to|able\s+to|let\s+me)\s+(breath)\b/gi,
    group: 1,
    message: 'The verb is “breathe”.',
    suggest: () => ['breathe'],
  },
  {
    id: 'everyday-every-day',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(everyday)\s+(?:I|we|you|they|he|she|it|at|after|before|when|since|for|in\s+the|morning|afternoon|evening|around)\b/gi,
    group: 1,
    message: '“Everyday” is an adjective. For “each day” use two words.',
    suggest: () => ['every day'],
  },
  {
    id: 'every-day-everyday',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(every\s+day)\s+(?:life|use|items|things|clothes|language|activities|routine|tasks|objects|people)\b/gi,
    group: 1,
    message: 'As an adjective it is one word: “everyday”.',
    suggest: () => ['everyday'],
  },
  {
    id: 'apart-a-part',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(apart)\s+of\b/gi,
    group: 1,
    message: 'Belonging to something is being “a part” of it.',
    suggest: () => ['a part'],
  },
  {
    id: 'whos-whose',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(who\s*['’]\s*s)\s+(?:car|house|book|turn|fault|idea|name|phone|job|bag|coat|keys|responsibility)\b/gi,
    group: 1,
    message: '“Who’s” means “who is”. The possessive is “whose”.',
    suggest: () => ['whose'],
  },
  {
    id: 'whose-whos',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(whose)\s+(?:going|coming|been|there|here|that|ready|next|in\s+charge|responsible)\b/gi,
    group: 1,
    message: 'Did you mean “who’s” (who is)?',
    suggest: () => ["who's"],
  },
  {
    id: 'piece-peace',
    category: 'grammar',
    short: 'Confused words',
    re: /\b(peace)\s+of\s+(?:cake|pizza|paper|advice|work|land|equipment|furniture|clothing)\b/gi,
    group: 1,
    message: 'A portion of something is a “piece”.',
    suggest: () => ['piece'],
  },
  {
    id: 'based-off',
    category: 'grammar',
    short: 'Word choice',
    re: /\bbased\s+(?:off\s+of|off)\b/gi,
    message: 'The standard phrase is “based on”.',
    suggest: () => ['based on'],
  },
  {
    id: 'comprised-of',
    category: 'style',
    short: 'Word choice',
    re: /\b(comprised\s+of)\b/gi,
    group: 1,
    message: 'A whole comprises its parts; it is “composed of” them.',
    suggest: () => ['composed of', 'made up of'],
  },
  {
    id: 'reason-is-because',
    category: 'style',
    short: 'Wordy',
    re: /\bthe\s+reason\s+(?:why\s+)?(?:is|was)\s+because\b/gi,
    message: '“The reason is that…” avoids saying it twice.',
    suggest: (m) => [m[0].replace(/why\s+/i, '').replace(/because/i, 'that')],
  },
  {
    id: 'fixed-phrase',
    category: 'grammar',
    short: 'Set phrase',
    re: /\b(?:for\s+all\s+intensive\s+purposes|one\s+in\s+the\s+same|should\s+of\s+went|by\s+in\s+large|tow\s+the\s+line|nip\s+it\s+in\s+the\s+butt|beckon\s+call|case\s+and\s+point|escape\s+goat|on\s+accident|deep\s+seeded|another\s+thing\s+coming|make\s+due|mute\s+point|statue\s+of\s+limitations|wet\s+your\s+appetite|would\s+of\s+went)\b/gi,
    message: 'That is not quite the standard phrase.',
    suggest: (m) => {
      const fixes = {
        'for all intensive purposes': 'for all intents and purposes',
        'one in the same': 'one and the same',
        'should of went': 'should have gone',
        'would of went': 'would have gone',
        'by in large': 'by and large',
        'tow the line': 'toe the line',
        'nip it in the butt': 'nip it in the bud',
        'beckon call': 'beck and call',
        'case and point': 'case in point',
        'escape goat': 'scapegoat',
        'on accident': 'by accident',
        'deep seeded': 'deep-seated',
        'another thing coming': 'another think coming',
        'make due': 'make do',
        'mute point': 'moot point',
        'statue of limitations': 'statute of limitations',
        'wet your appetite': 'whet your appetite',
      };
      const key = m[0].toLowerCase().replace(/\s+/g, ' ');
      return fixes[key] ? [matchCase(m[0], fixes[key])] : [];
    },
  },
  {
    id: 'nonstandard-word',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(irregardless|supposably|anyways|expresso|sherbert|libary|nucular|prolly|alot)\b/gi,
    message: '“$1” is not standard English.',
    suggest: (m) => {
      const fixes = {
        irregardless: 'regardless', supposably: 'supposedly', anyways: 'anyway',
        expresso: 'espresso', sherbert: 'sherbet', libary: 'library',
        nucular: 'nuclear', prolly: 'probably', alot: 'a lot',
      };
      return [matchCase(m[1], fixes[m[1].toLowerCase()])];
    },
  },

  // ---- verb forms and agreement ----------------------------------------
  {
    id: 'have-past-tense',
    category: 'grammar',
    short: 'Verb form',
    re: new RegExp(`\\b(have|has|had|having|['’]ve)\\s+(${alt(Object.keys(PARTICIPLES).filter((k) => !k.endsWith('_')))})\\b`, 'gi'),
    group: 2,
    message: 'After “$1”, use the past participle.',
    suggest: (m) => [PARTICIPLES[m[2].toLowerCase()]].filter(Boolean),
  },
  {
    id: 'modal-past-tense',
    category: 'grammar',
    short: 'Verb form',
    re: new RegExp(`\\b(will|would|can|could|shall|should|may|might|must|to)\\s+(${alt(Object.keys(BASE_FORMS))})\\b`, 'gi'),
    group: 2,
    message: 'After “$1”, use the plain form of the verb.',
    suggest: (m) => [BASE_FORMS[m[2].toLowerCase()]].filter(Boolean),
    exclude: (m) => /^to$/i.test(m[1]) && /^(had|got|said|left|felt|met|paid|lost|sent|spent|held|built|sold|heard|taught|caught|bought|brought|thought|found|told|kept|made|got)$/i.test(m[2]),
  },
  {
    id: 'he-dont',
    category: 'grammar',
    short: 'Agreement',
    // Not "that": in "things that don't work" it is standing in for "things".
    re: /\b(he|she|it|this|everyone|everybody|nobody|somebody|someone)\s+(don['’]t|do\s+not)\b/gi,
    group: 2,
    message: '“$1” takes “doesn’t”.',
    suggest: (m) => [/\s/.test(m[2]) ? 'does not' : "doesn't"],
    exclude: (m, doc) => !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    id: 'they-is',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(they|we|you|these|those|people|students|kids|children|parents|teachers)\s+(is|was)\b/gi,
    group: 2,
    message: '“$1” takes a plural verb.',
    suggest: (m) => [m[2].toLowerCase() === 'is' ? 'are' : 'were'],
    exclude: (m, doc) => !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    id: 'he-are',
    category: 'grammar',
    short: 'Agreement',
    // Not "that": "the things that are left" is a relative clause.
    re: /\b(he|she|it|this|there\s+(?:is|was))\s+(are|were)\b/gi,
    group: 2,
    message: '“$1” takes a singular verb.',
    suggest: (m) => [m[2].toLowerCase() === 'are' ? 'is' : 'was'],
    exclude: (m, doc) => !/^there\s/i.test(m[1]) && !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    id: 'i-is',
    category: 'grammar',
    short: 'Agreement',
    re: /\bI\s+(is|are|has|does)\b/g,
    group: 1,
    message: '“I” takes “am”, “have”, or “do”.',
    suggest: (m) => ({ is: 'am', are: 'am', has: 'have', does: 'do' }[m[1].toLowerCase()] ? [{ is: 'am', are: 'am', has: 'have', does: 'do' }[m[1].toLowerCase()]] : []),
  },
  {
    id: 'he-have',
    category: 'grammar',
    short: 'Agreement',
    // Not "that": "the people that have signed up" is a relative clause.
    re: /\b(he|she|it|this|everyone|everybody|nobody|somebody|someone)\s+(have)\b/gi,
    group: 2,
    message: '“$1” takes “has”.',
    suggest: () => ['has'],
    exclude: (m, doc) => !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    id: 'they-has',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(they|we|you|these|those)\s+(has)\b/gi,
    group: 2,
    message: '“$1” takes “have”.',
    suggest: () => ['have'],
    exclude: (m, doc) => !isTheSubject(doc, m.index, m[1], m[2]),
  },
  {
    id: 'dont-has',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(?:don't|doesn't|didn't|do\s+not|does\s+not|did\s+not)\s+(has)\b/gi,
    group: 1,
    message: 'After “do” the verb stays plain: “have”.',
    suggest: () => ['have'],
  },
  {
    id: 'does-they',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(does)\s+(?:they|we|you)\b/gi,
    group: 1,
    message: 'Use “do” with they, we and you.',
    suggest: () => ['do'],
  },
  {
    id: 'there-is-plural',
    category: 'grammar',
    short: 'Agreement',
    re: /\b(?:there|here)\s+(is|was)\s+(?:many|several|numerous|lots\s+of|two|three|four|five|six|seven|eight|nine|ten|dozens|hundreds|thousands|millions)\b/gi,
    group: 1,
    message: 'A plural subject needs “are” or “were”.',
    suggest: (m) => [m[1].toLowerCase() === 'is' ? 'are' : 'were'],
  },
  {
    id: 'i-seen',
    category: 'grammar',
    short: 'Verb form',
    re: /\b(I|we|they|you)\s+(seen|done|drank|swam|rang|sung|begun|drunk)\b/g,
    group: 2,
    message: 'That is a past participle: it needs “have” before it.',
    suggest: (m) => {
      const simple = { seen: 'saw', done: 'did', drank: 'drank', swam: 'swam', rang: 'rang', sung: 'sang', begun: 'began', drunk: 'drank' };
      const word = m[2].toLowerCase();
      return [simple[word] || word, `have ${word}`].filter((s, i, a) => a.indexOf(s) === i);
    },
    exclude: (m) => /^(drank|swam|rang)$/i.test(m[2]),
  },
  {
    id: 'double-negative',
    category: 'grammar',
    short: 'Double negative',
    // One verb may sit between the two negatives ("did not see nothing"), but
    // no more, or ordinary sentences like "don't know if nothing happened"
    // would be caught.
    re: /\b(?:don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|ain't|(?:do|does|did|can|could|will|would|should|have|has|had|is|are|was|were)\s+not)(?:\s+(?:see|saw|seen|say|said|tell|told|do|does|did|done|get|got|have|has|had|want|need|hear|heard|find|found|give|gave|make|made|take|took|go|going|went|be|been|wait|care|mind|like|feel|felt|notice|noticed|bring|brought|leave|left))?\s+(?:no|nothing|nobody|none|never|nowhere|no\s+one)\b/gi,
    message: 'Two negatives cancel out. Try one.',
    suggest: (m) => {
      const swap = { no: 'any', nothing: 'anything', nobody: 'anybody', none: 'any', never: 'ever', nowhere: 'anywhere', 'no one': 'anyone' };
      return [m[0].replace(/\b(no\s+one|nothing|nobody|none|never|nowhere|no)\b$/i, (w) => swap[w.toLowerCase().replace(/\s+/g, ' ')] || w)];
    },
  },
  {
    id: 'more-better',
    category: 'grammar',
    short: 'Comparison',
    re: /\b(?:more|most)\s+(better|worse|easier|harder|faster|slower|bigger|smaller|older|younger|best|worst)\b/gi,
    message: 'That comparison is already comparative.',
    suggest: (m) => [m[1]],
  },
  {
    id: 'less-fewer',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(less)\s+(?:people|students|children|kids|items|books|cars|things|dollars|hours|days|options|choices|teachers|parents|families)\b/gi,
    group: 1,
    message: 'Use “fewer” for things you can count.',
    suggest: () => ['fewer'],
  },
  {
    id: 'amount-number',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(amount)\s+of\s+(?:people|students|children|kids|items|books|cars|things|teachers|parents|families|questions|errors)\b/gi,
    group: 1,
    message: 'Use “number of” for things you can count.',
    suggest: () => ['number'],
  },
  {
    id: 'much-many',
    category: 'grammar',
    short: 'Word choice',
    re: /\b(much)\s+(?:people|students|children|kids|items|books|cars|things|teachers|parents|families|questions)\b/gi,
    group: 1,
    message: 'Use “many” for things you can count.',
    suggest: () => ['many'],
  },
  {
    id: 'between-you-and-i',
    category: 'grammar',
    short: 'Pronoun',
    re: /\b(?:between|for|with|to|from|of)\s+(?:you|him|her|them|us|Tim|Mary)\s+and\s+(I)\b/g,
    group: 1,
    message: 'After a preposition, use “me”.',
    suggest: () => ['me'],
  },
  {
    id: 'can-be-able',
    category: 'style',
    short: 'Wordy',
    re: /\b(can\s+be\s+able\s+to)\b/gi,
    group: 1,
    message: '“Can” already means “be able to”.',
    suggest: () => ['can'],
  },

  // ---- apostrophes ------------------------------------------------------
  {
    id: 'missing-apostrophe',
    category: 'punctuation',
    short: 'Apostrophe',
    re: new RegExp(`\\b(${alt(Object.keys(MISSING_APOSTROPHE))})\\b`, 'gi'),
    group: 1,
    message: 'Did you mean “$$FIX$$”?',
    suggest: (m) => [matchCase(m[1], MISSING_APOSTROPHE[m[1].toLowerCase()])],
    // "IM" and "AINT" in capitals are usually initialisms or shouting.
    exclude: (m) => m[1] === m[1].toUpperCase() && m[1].length <= 3,
  },
  {
    id: 'plural-apostrophe',
    category: 'punctuation',
    short: 'Apostrophe',
    re: /\b(\d{4}|19\d0|20\d0)\s*['’]s\b/g,
    message: 'Decades take no apostrophe.',
    suggest: (m) => [`${m[1]}s`],
  },
  {
    id: 'its-possessive-apostrophe',
    category: 'punctuation',
    short: 'Apostrophe',
    re: /\bits\s*['’](?![a-z])/gi,
    message: '“Its’” is never correct: use “its” or “it’s”.',
    suggest: () => ['its', "it's"],
  },
  {
    id: 'your-s',
    category: 'punctuation',
    short: 'Apostrophe',
    re: /\b(your\s*['’]\s*s|their\s*['’]\s*s|our\s*['’]\s*s|her\s*['’]\s*s|his\s*['’]\s*s)\b/gi,
    message: 'Possessive pronouns take no apostrophe.',
    suggest: (m) => [m[1].replace(/\s*['’]\s*s$/, 's').replace(/\s+/g, '')],
  },

  // ---- punctuation and spacing -----------------------------------------
  {
    id: 'space-before-punctuation',
    category: 'punctuation',
    short: 'Spacing',
    re: /(?<=[A-Za-z)\]"'])[ \t]+([,.;:!?])(?=([A-Za-z]?))/g,
    message: 'No space before punctuation.',
    // If a word follows straight after, the space moves rather than vanishes.
    suggest: (m) => [m[1] + (m[2] ? ' ' : '')],
  },
  {
    id: 'missing-space-after-comma',
    category: 'punctuation',
    short: 'Spacing',
    re: /([a-z]{2,30})([,;])([A-Za-z]{2,30})/g,
    message: 'Add a space after “$2”.',
    suggest: (m) => [`${m[1]}${m[2]} ${m[3]}`],
  },
  {
    id: 'missing-space-after-period',
    category: 'punctuation',
    short: 'Spacing',
    re: /([a-z]{2,30})([.!?])([A-Z][a-z]{1,30})/g,
    message: 'Add a space between sentences.',
    suggest: (m) => [`${m[1]}${m[2]} ${m[3]}`],
    exclude: (m, doc) => {
      const domain = /^(com|org|net|edu|gov|io|co|uk|us|ca|de|me|tv|info|biz)$/i;
      if (domain.test(m[3])) return true;
      return /^(?:mr|mrs|ms|dr|prof|st|jr|sr|inc|ltd|vs|etc|eg|ie|no|approx)$/i.test(m[1])
        || /[@/\\]/.test(doc.text.slice(Math.max(0, m.index - 12), m.index));
    },
  },
  {
    id: 'double-space',
    category: 'punctuation',
    short: 'Spacing',
    re: /(?<=[^\s.!?:;,])\x20{2,}(?=[^\s])/g,
    message: 'Two spaces in the middle of a sentence.',
    suggest: () => [' '],
  },
  {
    id: 'repeated-punctuation',
    category: 'punctuation',
    short: 'Punctuation',
    // Three dots is an ellipsis and is left alone. Two is a typo, four or
    // more is a mash.
    re: /([,;:])\1+|(?<!\.)(\.\.)(?!\.)|(\.{4,})|([?!])[?!]{2,}/g,
    message: 'Repeated punctuation.',
    suggest: (m) => {
      if (m[1]) return [m[1]];
      if (m[2]) return ['.', '…'];
      if (m[3]) return ['…', '.'];
      return [m[4]];
    },
  },
  {
    id: 'doubled-word',
    category: 'grammar',
    short: 'Repeated word',
    // Deliberately not \s+: "Thanks\nThanks for coming" is two lines, and
    // replacing across the break would delete it.
    re: /\b([A-Za-z]{2,40})[ \t]+\1\b/gi,
    message: '“$1” is repeated.',
    suggest: (m) => [m[1]],
    exclude: (m) => /^(had|that|no|ha|blah|yeah|ok|hey|night|bye|cheers|knock|tick|bang|boo|so|very|really|long|good|hot|far|deep|new|wall|new\s+york)$/i.test(m[1]),
  },

  // ---- style ------------------------------------------------------------
  {
    id: 'wordy-phrase',
    category: 'style',
    short: 'Wordy',
    re: new RegExp(`\\b(${alt(Object.keys(WORDY).map((k) => k.replace(/ /g, '\\s+')))})\\b`, 'gi'),
    group: 1,
    message: 'Shorter: “$$FIX$$”.',
    suggest: (m) => {
      const key = m[1].toLowerCase().replace(/\s+/g, ' ');
      const fix = WORDY[key];
      return fix ? [matchCase(m[1], fix)] : [];
    },
    confidence: 'low',
  },
  {
    id: 'deletable-phrase',
    category: 'style',
    short: 'Wordy',
    re: new RegExp(`\\b(${alt(DELETABLE.map((k) => k.replace(/ /g, '\\s+')))})\\s*`, 'gi'),
    message: 'This phrase adds nothing. The sentence is stronger without it.',
    suggest: () => [''],
    confidence: 'low',
  },
  {
    id: 'redundant-phrase',
    category: 'style',
    short: 'Redundant',
    re: new RegExp(`\\b(${alt(Object.keys(REDUNDANT).map((k) => k.replace(/ /g, '\\s+')))})\\b`, 'gi'),
    group: 1,
    message: 'Says the same thing twice.',
    suggest: (m) => {
      const key = m[1].toLowerCase().replace(/\s+/g, ' ');
      const fix = REDUNDANT[key];
      return fix ? [matchCase(m[1], fix)] : [];
    },
  },
  {
    // Extra picky only. These are how people actually write to each other,
    // and underlining "ok" in every chat message by default is a nag. A
    // capital "OK" is simply correct and is never mentioned.
    id: 'informal',
    category: 'advanced',
    short: 'Informal',
    re: /\b(alright|ain't|y'all|ok)\b/gi,
    group: 1,
    exclude: (m) => m[1] === 'OK',
    message: '“$1” is informal.',
    suggest: (m) => {
      const fixes = { alright: 'all right', "ain't": 'is not', "y'all": 'you all', ok: 'OK' };
      const fix = fixes[m[1].toLowerCase()];
      return fix ? [matchCase(m[1], fix)] : [];
    },
    confidence: 'low',
  },
  {
    id: 'try-and',
    category: 'style',
    short: 'Word choice',
    re: /\b(try\s+and)\s+(?:[a-z]+)\b/gi,
    group: 1,
    message: '“Try to” is the standard form in writing.',
    suggest: () => ['try to'],
    confidence: 'low',
  },
  {
    id: 'different-than',
    category: 'style',
    short: 'Word choice',
    re: /\b(different\s+than)\b/gi,
    group: 1,
    message: '“Different from” is preferred in formal writing.',
    suggest: () => ['different from'],
    confidence: 'low',
  },

  // ---- advanced (off by default) ---------------------------------------
  {
    id: 'filler-word',
    category: 'advanced',
    short: 'Filler',
    re: /\b(very|really|quite|just|actually|basically|literally|simply|totally|definitely|honestly|obviously|essentially|virtually)\s+(?=[a-z])/gi,
    group: 1,
    message: '“$1” usually adds nothing. Consider cutting it.',
    suggest: () => [''],
    confidence: 'low',
  },
  {
    id: 'passive-voice',
    category: 'advanced',
    short: 'Passive voice',
    re: /\b(?:am|is|are|was|were|be|been|being)\s+(\w{2,25}ed|born|done|made|given|taken|written|known|seen|found|used|held|kept|sent|built|shown|told|paid|left|led|felt|brought|bought|caught|taught)\s+by\b/gi,
    message: 'Passive voice. Naming who acts is usually clearer.',
    suggest: () => [],
    confidence: 'low',
  },
  {
    id: 'comma-before-conjunction',
    category: 'advanced',
    short: 'Comma',
    re: /\b([a-z]{3,20})\s+(and|but|so|yet|or)\s+(I|we|he|she|they|it|you)\s+(?:\w{2,20}ed|will|would|can|could|should|have|has|had|am|is|are|was|were)\b/g,
    message: 'Two full clauses usually take a comma before “$2”.',
    suggest: (m) => [`${m[1]}, ${m[2]} ${m[3]}`],
    confidence: 'low',
  },
];

// ---------------------------------------------------------------------------
// rules that need more than a regular expression
// ---------------------------------------------------------------------------

// Acronym plurals - CDs, TVs, PDFs - are not a caps-lock slip.
const ACRONYM_PLURAL = /^[A-Z]{2,}s$/;

const FUNCTION_RULES = [
  {
    id: 'proper-noun-capital',
    category: 'grammar',
    short: 'Capitalization',
    run(doc, options) {
      const dict = options.dict;
      if (!dict || !dict.properForm) return [];
      const issues = [];
      const haystack = doc.normalized || doc.text;
      for (const token of doc.tokens) {
        if (token.skip || token.glued || token.mixedCase) continue;
        if (token.capitalized || token.allCaps) continue;
        const name = dict.properForm(token.lower);
        if (!name) continue;
        if (name.form.toLowerCase() === name.form) continue;
        if (name.ambiguous) {
          // rose, will, may, mark, good: these are ordinary words that happen
          // to also be names, so the sentence has to say outright that it means
          // the name. Anything less and "this is good" becomes Mr Good.
          const before = haystack.slice(Math.max(0, token.start - 28), token.start);
          const after = haystack.slice(token.end, token.end + 12);
          const stated = NAME_STATED.test(before);
          const titled = NAME_TITLE.test(before);
          const addressed = NAME_GREETING.test(before) && NAME_ADDRESSED.test(after);
          if (!stated && !titled && !addressed) continue;
          // "The Dr. will see you now", "your Rep. may vote against it": after
          // a title, "will" and "may" followed by another word are the verbs,
          // not Will and May.
          if (titled && !stated && /^(?:will|may)$/.test(token.lower) && /^\s+[a-z]/.test(after)) continue;
        }
        issues.push({
          id: 'proper-noun-capital',
          category: 'grammar',
          short: 'Capitalization',
          start: token.start,
          end: token.end,
          text: token.text,
          message: `“${name.form}” is a name, so it takes a capital letter.`,
          replacements: [name.form],
          confidence: name.ambiguous ? 'low' : 'high',
        });
      }
      return issues;
    },
  },
  {
    id: 'double-capital',
    category: 'grammar',
    short: 'Capitalization',
    run(doc, options) {
      const issues = [];
      const dict = options.dict;
      const re = /\b([A-Z]{2})([a-z]+)\b/g;
      const haystack = doc.normalized || doc.text;
      let m;
      while ((m = re.exec(haystack)) !== null) {
        const word = m[0];
        const start = m.index;
        const end = start + word.length;
        if (inSkipRange(doc.skipRanges, start, end)) continue;
        if (ACRONYM_PLURAL.test(word)) continue;
        // A word we do not know is more likely a product name than a slip.
        const lower = word.toLowerCase();
        if (dict && !dict.isKnown(lower) && !(dict.properForm && dict.properForm(lower))) continue;
        const known = dict && dict.properForm ? dict.properForm(lower) : null;
        const fixed = known ? known.form : word.charAt(0) + word.slice(1).toLowerCase();
        if (fixed === word) continue;
        issues.push({
          id: 'double-capital',
          category: 'grammar',
          short: 'Capitalization',
          start,
          end,
          text: doc.text.slice(start, end),
          message: 'Two capitals at the start of a word - the shift key held a moment too long.',
          replacements: [fixed],
          confidence: 'high',
        });
      }
      return issues;
    },
  },
  {
    id: 'article-agreement',
    category: 'grammar',
    short: 'Article',
    run(doc) {
      const issues = [];
      const re = /\b(an?)(\s+)([A-Za-z][\w'-]*)/g;
      let m;
      while ((m = re.exec(doc.text)) !== null) {
        const article = m[1];
        const word = m[3];
        const start = m.index;
        const end = start + m[1].length;
        if (inSkipRange(doc.skipRanges, start, m.index + m[0].length)) continue;
        const isAn = article.toLowerCase() === 'an';
        const startsWithVowel = /^[aeiou]/i.test(word);
        let wantsAn;
        if (startsWithVowel) wantsAn = !CONSONANT_SOUND.test(word);
        else if (VOWEL_SOUND.test(word)) wantsAn = true;
        else if (word === word.toUpperCase() && word.length > 1) wantsAn = VOWEL_LETTERS.test(word);
        else wantsAn = false;
        if (wantsAn === isAn) continue;
        issues.push({
          id: 'article-agreement',
          category: 'grammar',
          short: 'Article',
          start,
          end,
          text: article,
          message: wantsAn
            ? `Use “an” before “${word}”.`
            : `Use “a” before “${word}”.`,
          replacements: [matchCase(article, wantsAn ? 'an' : 'a')],
          confidence: 'high',
        });
      }
      return issues;
    },
  },
  {
    id: 'lowercase-i',
    category: 'grammar',
    short: 'Capitalization',
    run(doc) {
      const issues = [];
      const re = /(^|[^\w'’])i(['’](?:m|ve|ll|d)\b|(?=[\s,.;:!?)"]|$))/g;
      let m;
      while ((m = re.exec(doc.text)) !== null) {
        const start = m.index + m[1].length;
        const end = start + 1 + (m[2] && m[2][0] !== '(' && m[2].length > 1 ? m[2].length : 0);
        if (inSkipRange(doc.skipRanges, start, end)) continue;
        const word = doc.text.slice(start, end);
        issues.push({
          id: 'lowercase-i',
          category: 'grammar',
          short: 'Capitalization',
          start,
          end,
          text: word,
          message: 'The pronoun “I” is always capitalized.',
          replacements: [`I${word.slice(1)}`],
          confidence: 'high',
        });
      }
      return issues;
    },
  },
  {
    id: 'sentence-capital',
    category: 'grammar',
    short: 'Capitalization',
    prose: true,
    run(doc) {
      const issues = [];
      if (doc.sentences.length === 0) return issues;
      // If most sentences start lower case, that is a deliberate style.
      let lower = 0;
      let counted = 0;
      for (const sentence of doc.sentences) {
        const ch = doc.text[sentence.start];
        if (!/[A-Za-z]/.test(ch)) continue;
        counted += 1;
        if (ch === ch.toLowerCase()) lower += 1;
      }
      if (counted === 0 || lower > Math.max(2, counted * 0.6)) return issues;
      for (const sentence of doc.sentences) {
        if (sentence.afterEllipsis) continue;
        const start = sentence.start;
        const ch = doc.text[start];
        if (!/[a-z]/.test(ch)) continue;
        if (inSkipRange(doc.skipRanges, start, start + 1)) continue;
        const word = /^[a-z']+/.exec(doc.text.slice(start, sentence.end));
        if (!word) continue;
        issues.push({
          id: 'sentence-capital',
          category: 'grammar',
          short: 'Capitalization',
          start,
          end: start + word[0].length,
          text: word[0],
          message: 'Start the sentence with a capital letter.',
          replacements: [word[0].charAt(0).toUpperCase() + word[0].slice(1)],
          confidence: 'high',
        });
      }
      return issues;
    },
  },
];

// Every rule gets the /d flag so a capture group can be underlined on its own.
const COMPILED = RULES.map((rule) => ({
  ...rule,
  re: rule.re.flags.includes('d')
    ? rule.re
    : new RegExp(rule.re.source, `${rule.re.flags}d`),
}));

export const ALL_RULE_IDS = COMPILED.map((r) => r.id).concat(FUNCTION_RULES.map((r) => r.id));

/**
 * @param {object} doc from analyze()
 * @param {object} options {categories: {grammar: true, ...}, disabledRules: Set}
 * @returns {object[]} issues
 */
export function runRules(doc, options = {}) {
  const categories = options.categories || {};
  // "advanced" is the noisy set: opt in, never on by default.
  const enabled = (name) => (categories[name] === undefined
    ? name !== 'advanced'
    : categories[name] !== false);
  const disabled = options.disabledRules || new Set();
  const issues = [];

  // A single "word" tens of thousands of characters long is a paste of data,
  // not prose. Grammar rules have nothing to say about it.
  const haystackTooOdd = doc.text.length > 4000 && doc.wordCount < doc.text.length / 400;

  for (const rule of COMPILED) {
    if (!enabled(rule.category) || disabled.has(rule.id)) continue;
    if (rule.prose && !doc.isProse) continue;
    if (haystackTooOdd && rule.category !== 'spelling') continue;
    rule.re.lastIndex = 0;
    const haystack = doc.normalized || doc.text;
    let m;
    let guard = 0;
    while ((m = rule.re.exec(haystack)) !== null) {
      if (guard += 1, guard > 400) break;
      if (m[0].length === 0) { rule.re.lastIndex += 1; continue; }
      const span = (m.indices && (m.indices[rule.group || 0] || m.indices[0])) || [m.index, m.index + m[0].length];
      const [start, end] = span;
      if (inSkipRange(doc.skipRanges, start, end)) continue;
      if (rule.exclude && rule.exclude(m, doc)) continue;
      const raw = typeof rule.suggest === 'function' ? rule.suggest(m, doc) : (rule.suggest || []);
      const text = doc.text.slice(start, end);
      const replacements = (raw || [])
        .filter((r) => r !== undefined && r !== null && r !== text)
        .map((r) => (rule.rawCase ? r : matchCase(text, r)));
      let message = fillTemplate(rule.message, m);
      if (message.includes('$$FIX$$')) {
        message = replacements[0]
          ? message.replace('$$FIX$$', replacements[0])
          : 'This phrase can be cut.';
      }
      issues.push({
        id: rule.id,
        category: rule.category,
        short: rule.short,
        start,
        end,
        text,
        message,
        replacements,
        confidence: rule.confidence || 'high',
      });
    }
  }

  for (const rule of FUNCTION_RULES) {
    if (!enabled(rule.category) || disabled.has(rule.id)) continue;
    if (rule.prose && !doc.isProse) continue;
    issues.push(...rule.run(doc, options));
  }

  return issues;
}
