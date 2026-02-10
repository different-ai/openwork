package com.winning.spark

import org.apache.spark.sql.SparkSession
import com.winning.spark.config.SparkConfig

object SparkSessionManager {
  @volatile private var instance: Option[SparkSession] = None
  
  def getOrCreate(config: SparkConfig): SparkSession = {
    instance.synchronized {
      instance.getOrElse {
        val spark = SparkSession.builder()
          .appName(config.appName)
          .master(config.master)
          .config("spark.sql.adaptive.enabled", "true")
          .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
          .config("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
          .getOrCreate()
        
        instance = Some(spark)
        spark
      }
    }
  }
  
  def stop(): Unit = {
    instance.synchronized {
      instance.foreach(_.stop())
      instance = None
    }
  }
}
