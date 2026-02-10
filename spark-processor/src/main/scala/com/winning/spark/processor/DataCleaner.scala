package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.ProcessorConfig

class DataCleaner extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    if (!config.cleaning.enabled) {
      return df
    }
    
    var result = df
    
    // Trim whitespace for string columns
    if (config.cleaning.trimWhitespace) {
      result = result.columns.foldLeft(result) { (acc, colName) =>
        val colType = acc.schema(colName).dataType
        if (colType.typeName == "string") {
          acc.withColumn(colName, trim(col(colName)))
        } else {
          acc
        }
      }
    }
    
    // Remove duplicates
    if (config.cleaning.removeDuplicates) {
      result = result.dropDuplicates()
    }
    
    result
  }
}
