import { pgp, SupabaseDirectClient } from 'shared/supabase/init'
import { fromPairs } from 'lodash'
import {
  ALL_FEED_USER_ID,
  DEFAULT_FEED_USER_ID,
  FEED_REASON_TYPES,
  INTEREST_DISTANCE_THRESHOLDS,
} from 'common/feed'
import { Row } from 'common/supabase/utils'
import { log } from 'shared/utils'
import { ITask } from 'pg-promise'
import { IClient } from 'pg-promise/typescript/pg-subset'
import { MONTH_MS } from 'common/util/time'

export const getUserFollowerIds = async (
  userId: string,
  pg: SupabaseDirectClient
) => {
  const userFollowerIds = await pg.manyOrNone<{ user_id: string }>(
    `select user_id from user_follows where follow_id = $1`,
    [userId]
  )
  return userFollowerIds.map((r) => r.user_id)
}

export const getUsersWithSimilarInterestVectorToNews = async (
  newsId: string,
  pg: SupabaseDirectClient
) => {
  const userIdsAndDistances = await pg.manyOrNone<{
    user_id: string
    distance: number
  }>(
    // The indices don't work great (returns ~half the users) for far out of sample vectors, running a seq
    // scan instead by omitting the order by clause.
    `
    with ce as (
        select title_embedding
        from news
        where news.id = $1
    )
    select user_id, distance
    from (
             select ue.user_id, (select title_embedding from ce) <=> ue.interest_embedding as distance
             from user_embeddings as ue
         ) as distances
    where distance < $2
  `,
    [newsId, INTEREST_DISTANCE_THRESHOLDS.news_with_related_contracts]
  )
  return fromPairs(
    userIdsAndDistances.map((r) => [
      r.user_id,
      'similar_interest_vector_to_news_vector' as FEED_REASON_TYPES,
    ])
  )
}

export const spiceUpNewUsersFeedBasedOnTheirInterests = async (
  userId: string,
  pg: SupabaseDirectClient
) => {
  await pg.tx(async (t) => {
    await t.none('SET LOCAL ivfflat.probes = $1', [20])
    const relatedFeedItems = await t.manyOrNone<Row<'user_feed'>>(
      `              
          WITH user_embedding AS (
            SELECT interest_embedding
            FROM user_embeddings
            WHERE user_id = $1
          ),
          interesting_contract_embeddings AS (
             SELECT contract_id
             FROM contract_embeddings
             where (SELECT interest_embedding FROM user_embedding) <=> embedding < $2
           ),
           filtered_user_feed AS (
               SELECT DISTINCT ON (contract_id) *
               FROM user_feed
               WHERE contract_id IN (SELECT contract_id FROM interesting_contract_embeddings)
               and created_time > now() - interval '10 days'
               and user_id = $3
               limit $4
           )
          SELECT *
          FROM filtered_user_feed
        `,
      [userId, 0.25, ALL_FEED_USER_ID, 250]
    )
    log('found relatedFeedItems', relatedFeedItems.length)

    return copyOverFeedItems(userId, relatedFeedItems, t)
  })
}

export const populateNewUsersFeedFromDefaultFeed = async (
  userId: string,
  pg: SupabaseDirectClient
) => {
  await pg.tx(async (t) => {
    await t.none('SET LOCAL ivfflat.probes = $1', [10])
    const relatedFeedItems = await t.manyOrNone<userFeedRowAndDistance>(
      `
          with user_embedding as (
              select interest_embedding
              from user_embeddings
              where user_id = $1
          ),
         contract_embeddings_for_user_feed as (
             select contract_embeddings.contract_id, contract_embeddings.embedding
             from contract_embeddings
             where contract_embeddings.contract_id in (
                 select contract_id
                 from user_feed
                 where user_id = $2
                 order by created_time desc
                 limit 200
             )
         ),
         interesting_contracts as (
             select
                 contract_embeddings_for_user_feed.contract_id,
                 contract_embeddings_for_user_feed.embedding <=> user_embedding.interest_embedding as distance
             from contract_embeddings_for_user_feed, user_embedding
         )
          select user_feed.*, interesting_contracts.distance
          from user_feed
                   join interesting_contracts on user_feed.contract_id = interesting_contracts.contract_id
          where user_feed.user_id = $2
          order by interesting_contracts.distance;
          `,
      [userId, DEFAULT_FEED_USER_ID]
    )

    log('found', relatedFeedItems.length, 'feed items to copy')
    return copyOverFeedItems(userId, relatedFeedItems, t)
  })
}
type userFeedRowAndDistance = Row<'user_feed'> & { distance?: number }
const copyOverFeedItems = async (
  userId: string,
  relatedFeedItems: userFeedRowAndDistance[],
  pg: ITask<IClient> & IClient
) => {
  if (relatedFeedItems.length === 0) return []
  const now = Date.now()
  const updatedRows = relatedFeedItems.map((row, i) => {
    // assuming you want to change the 'columnToChange' column
    const { id: __, distance: _, ...newRow } = row
    newRow.user_id = userId
    newRow.is_copied = true
    newRow.created_time = new Date(now - i * 100).toISOString()
    return newRow
  })
  const cs = new pgp.helpers.ColumnSet(updatedRows[0], { table: 'user_feed' })
  const insert = pgp.helpers.insert(updatedRows, cs) + ' ON CONFLICT DO NOTHING'

  try {
    await pg.none(insert)
  } catch (e) {
    console.log('error inserting feed items')
    console.error(e)
  }

  return relatedFeedItems
}

export const getWhenToIgnoreUsersTime = () => {
  // Always get the same time a month ago today so postgres can cache the query
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  return today.getTime() - MONTH_MS
}
