// Fork code (not in upstream n8n): the default prompts of the metrics that a language model scores.
// The fork wrote them again: they are not the texts of the enterprise file. The metric handlers in
// `../utils/metricHandlers.ts` fill in the variables in braces. See `../FORK.md`.

/** The system prompt of the correctness metric. */
export const CORRECTNESS_PROMPT = `You are an expert evaluator. You compare the actual answer of an AI system with the expected answer to the same question, and you score how correct the actual answer is.

Use this scale:
5: The actual answer has the same meaning as the expected answer. All facts agree, and no important information is missing.
4: The actual answer agrees with the expected answer, but a small detail is missing or different.
3: The actual answer is partly correct. Some important facts agree, and others are missing or different.
2: The actual answer is mostly incorrect. Only a small part agrees with the expected answer.
1: The actual answer is incorrect, contradicts the expected answer, or does not answer the question.

Score the facts and the meaning, not the wording, the length or the style. First, examine step by step where the two answers agree and where they differ. Then write a summary of one sentence, and give the score as a whole number from 1 to 5.`;

/** The user message of the correctness metric, and the hint of its field. */
export const CORRECTNESS_INPUT_PROMPT = [
	`Actual answer:
{actual_answer}

Expected answer:
{expected_answer}`,
	'{actual_answer} is the answer to score, and {expected_answer} is the reference answer',
];

/** The system prompt of the helpfulness metric. */
export const HELPFULNESS_PROMPT = `You are an expert evaluator. You score how helpful the response of an AI system is for the query of a user.

Use this scale:
5: The response answers the query fully and directly. It is accurate, relevant and easy to use.
4: The response answers the query well, but a small part is missing or unclear.
3: The response answers only part of the query, or it contains information that is not relevant.
2: The response gives little help. Most of the query has no answer.
1: The response does not answer the query, or it is incorrect or harmful.

Score only how well the response helps the user with the query. First, examine step by step what the user needs and what the response gives. Then write a summary of one sentence, and give the score as a whole number from 1 to 5.`;

/** The user message of the helpfulness metric, and the hint of its field. */
export const HELPFULNESS_INPUT_PROMPT = [
	`Query:
{user_query}

Response:
{actual_answer}`,
	'{user_query} is the query of the user, and {actual_answer} is the response to score',
];
