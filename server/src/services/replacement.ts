import { Result, ok, err } from 'neverthrow'
import type pg from 'pg'
import { getSocketByUserID, getSocketsInGame, nsp, sendUpdatesOfGameToPlayers } from '../socket/game'
import type { GameForPlay } from '../sharedTypes/typesDBgame'
import { getGame, updateGame } from './game'
import { initalizeStatistic } from '../game/statistic'
import { addJob } from './scheduledTasks'
import { scheduleJob } from 'node-schedule'
import { getUser } from './user'

const MAX_TIME_FOR_REPLACEMENT = 60 * 1000

export function checkReplacementConditions(game: GameForPlay, playerIndexToReplace: number, replacementPlayerID: number): boolean {
  return (
    game.status === 'running' &&
    game.game.replacement == null &&
    game.game.activePlayer === playerIndexToReplace &&
    Date.now() - game.lastPlayed > 60 * 1000 &&
    !game.playerIDs.includes(replacementPlayerID)
  )
}

export async function startReplacement(pgPool: pg.Pool, game: GameForPlay, replacementPlayerID: number, playerIndexToReplace: number) {
  const user = await getUser(pgPool, { id: replacementPlayerID })
  if (user.isErr()) {
    throw ''
  }

  game.game.replacement = {
    replacementUserID: replacementPlayerID,
    replacementUsername: user.value.username,
    playerIndexToReplace: playerIndexToReplace,
    acceptedByIndex: [],
    rejectedByIndex: [],
    startDate: Date.now(),
  }
  await updateGame(pgPool, game.id, game.game.getJSON(), game.status, false, false)
  sendUpdatesOfGameToPlayers(game)

  addJob(
    scheduleJob(Date.now() + MAX_TIME_FOR_REPLACEMENT, async () => {
      const newGame = await getGame(pgPool, game.id)
      await endReplacementOnTime(pgPool, newGame)
    })
  )
}

export type AcceptReplacementError = 'NO_ACTIVE_REPLACEMENT' | 'REPLACEMENT_ALREADY_ACCEPTED' | 'CANNOT_ACCEPT_OWN_REPLACEMENT'
export async function acceptReplacement(pgPool: pg.Pool, game: GameForPlay, userID: number): Promise<Result<null, AcceptReplacementError>> {
  if (game.game.replacement == null) {
    return err('NO_ACTIVE_REPLACEMENT')
  }

  const playerIndex = game.playerIDs.findIndex((id) => id == userID)
  if (game.game.replacement.acceptedByIndex.includes(playerIndex)) {
    return err('REPLACEMENT_ALREADY_ACCEPTED')
  }

  if (game.game.replacement.playerIndexToReplace === playerIndex) {
    return err('CANNOT_ACCEPT_OWN_REPLACEMENT')
  }

  game.game.replacement.acceptedByIndex.push(playerIndex)
  if (game.game.replacement.acceptedByIndex.length >= game.game.nPlayers - 1) {
    const playerIndexAdditional = game.game.statistic.length
    if (game.game.replacement.playerIndexToReplace === -1) {
      throw new Error('Replacement failed as playerIndex could not be found')
    }

    game.game.replacedPlayerIndices.push(game.game.replacement.playerIndexToReplace)

    // handle statistics
    game.game.statistic.push(initalizeStatistic(1)[0])
    ;[game.game.statistic[playerIndexAdditional], game.game.statistic[game.game.replacement.playerIndexToReplace]] = [
      game.game.statistic[game.game.replacement.playerIndexToReplace],
      game.game.statistic[playerIndexAdditional],
    ]

    await pgPool.query('UPDATE users_to_games SET player_index = $1 WHERE userid = $2 AND gameid = $3;', [
      playerIndexAdditional,
      game.playerIDs[game.game.replacement.playerIndexToReplace],
      game.id,
    ])
    await pgPool.query('INSERT INTO users_to_games (player_index, userid, gameid) VALUES ($1, $2, $3);', [
      game.game.replacement.playerIndexToReplace,
      game.game.replacement.replacementUserID,
      game.id,
    ])
    // TBD -> Consequences?

    getSocketByUserID(game.playerIDs[game.game.replacement.playerIndexToReplace])?.disconnect()
    const newSocket = getSocketByUserID(game.game.replacement.replacementUserID)
    if (newSocket != null) {
      newSocket.data.gamePlayer = game.game.replacement.playerIndexToReplace
      newSocket.emit('replacement:changeGamePlayer', game.game.replacement.playerIndexToReplace)
    }
    getSocketsInGame(nsp, game.id).forEach((s) =>
      s.emit('toast:replacement-done', game.game.replacement?.replacementUsername ?? '', game.players[game.game.replacement?.playerIndexToReplace ?? 0])
    )

    delete game.game.replacement
  }

  await updateGame(pgPool, game.id, game.game.getJSON(), game.status, false, false)
  sendUpdatesOfGameToPlayers(game)
  return ok(null)
}

export type RejectReplacementError = 'NO_RUNNING_REPLACEMENT'
export async function rejectReplacement(pgPool: pg.Pool, game: GameForPlay, userID: number): Promise<Result<null, RejectReplacementError>> {
  if (game.game.replacement == null) {
    return err('NO_RUNNING_REPLACEMENT')
  }

  // TBD more checks
  const playerIndex = game.playerIDs.findIndex((id) => id == userID)
  game.game.replacement.rejectedByIndex.push(playerIndex)
  delete game.game.replacement
  await updateGame(pgPool, game.id, game.game.getJSON(), game.status, false, false)
  sendUpdatesOfGameToPlayers(game)
  return ok(null)
}

export async function endReplacementOnTime(pgPool: pg.Pool, game: GameForPlay) {
  if (game.game.replacement != null && Date.now() - game.game.replacement.startDate > MAX_TIME_FOR_REPLACEMENT) {
    delete game.game.replacement
    await updateGame(pgPool, game.id, game.game.getJSON(), game.status, false, false)
    sendUpdatesOfGameToPlayers(game)
  }
}

// TBD: on unconnect end replacement
