import * as admin from 'firebase-admin'
import { z } from 'zod'
import { APIError, authEndpoint, validate } from './helpers'
import { createSupabaseDirectClient } from 'shared/supabase/init'
import { runReturnLeagueBidTxn, runTxn } from 'shared/txn/run-txn'
import { maxBy } from 'lodash'
import { LeagueBidTxn } from 'common/txn'
import {
  IS_BIDDING_PERIOD,
  MIN_BID_INCREASE_FACTOR,
  MIN_LEAGUE_BID,
} from 'common/leagues'
import { getLeagueChatChannelId } from 'common/league-chat'

const schema = z.object({
  season: z.number(),
  division: z.number(),
  cohort: z.string(),
  amount: z.number(),
})

export const bidforleague = authEndpoint(async (req, auth) => {
  const { season, division, cohort, amount } = validate(schema, req.body)

  const db = createSupabaseDirectClient()

  const user = await db.one(
    'select data from users where id = $1',
    [auth.uid],
    (row) => row.data
  )

  if (!IS_BIDDING_PERIOD) {
    throw new APIError(403, 'Bidding is not currently open')
  }

  if (!user) {
    throw new APIError(401, 'Your account was not found')
  }

  if (user.balance < amount) {
    throw new APIError(403, 'Insufficient balance')
  }

  return await firestore.runTransaction(async (transaction) => {
    const leagueId = `${season}-${division}-${cohort}`
    const bidsSnapshot = await transaction.get(
      firestore
        .collection('txns')
        .where('category', '==', 'LEAGUE_BID')
        .where('toId', '==', leagueId)
    )
    const bids = bidsSnapshot.docs.map((doc) => doc.data() as LeagueBidTxn)
    const maxBid = maxBy(bids, (bid) => bid.amount)

    if (!maxBid && amount < MIN_LEAGUE_BID) {
      throw new APIError(403, 'Minimum bid is M' + MIN_LEAGUE_BID)
    }
    if (maxBid && amount < maxBid.amount * MIN_BID_INCREASE_FACTOR) {
      throw new APIError(
        403,
        'Bid must be at least ' +
          MIN_BID_INCREASE_FACTOR +
          ' times higher than current.'
      )
    }

    console.log(
      'got',
      season,
      division,
      cohort,
      'amount',
      amount,
      'with max bid',
      maxBid?.amount
    )

    const { txn } = await runTxn(transaction, {
      fromId: auth.uid,
      fromType: 'USER',
      toType: 'LEAGUE',
      toId: leagueId,
      amount,
      token: 'M$',
      category: 'LEAGUE_BID',
      data: {
        season,
        division,
        cohort,
      },
    })

    if (maxBid) {
      runReturnLeagueBidTxn(transaction, maxBid)
    }

    const pg = createSupabaseDirectClient()
    console.log(
      'updating',
      getLeagueChatChannelId(season, division, cohort),
      'owner to',
      auth.uid
    )
    await pg.none(
      'update league_chats set owner_id = $1 where channel_id = $2',
      [auth.uid, getLeagueChatChannelId(season, division, cohort)]
    )

    return { status: 'success', txn }
  })
})

const firestore = admin.firestore()
