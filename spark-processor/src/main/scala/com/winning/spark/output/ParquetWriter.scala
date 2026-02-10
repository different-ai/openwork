package com.winning.spark.output

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.OutputConfig

class ParquetWriter extends DataOutput {
  override def write(df: DataFrame, config: OutputConfig): Unit = {
    val writer = df.write
      .mode(config.mode)
      .format("parquet")
    
    if (config.partitionBy.nonEmpty) {
      writer.partitionBy(config.partitionBy: _*)
    }
    
    writer.save(config.path)
  }
}
