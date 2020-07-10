import { Context } from "@azure/functions";
import { BlobService } from "azure-storage";
import { sequenceT } from "fp-ts/lib/Apply";
import { taskEither } from "fp-ts/lib/TaskEither";
import { fromLeft } from "fp-ts/lib/TaskEither";
import {
  exportAbolishedMunicipality,
  exportCurrentMunicipalities,
  exportForeignMunicipalities
} from "../utils/municipality";

const logPrefix = "getUpdateMunicipalitiesHandler";

/**
 * Returns a function for handling UpdateMunicipalities
 */
export const getUpdateMunicipalitiesHandler = (
  blobService: BlobService
) => async (context: Context): Promise<unknown> => {
  return sequenceT(taskEither)(
    exportAbolishedMunicipality(blobService),
    exportCurrentMunicipalities(blobService),
    exportForeignMunicipalities(blobService)
  )
    .mapLeft(err => {
      context.log.error(`${logPrefix}|Cannot update municipalities|${err}`);
      return fromLeft(err);
    })
    .run();
};
